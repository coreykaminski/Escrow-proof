/**
 * Stablecoin rail against a real chain (Base Sepolia testnet, or a local anvil): the whole API
 * flow in-process — terms → buyer signs (gasless) → Proof Desk relays → deliver → decide
 * partial 60% → settle on-chain — then checks the USDC balances moved exactly as decided.
 *
 *   CHAIN_RPC_URL=https://sepolia.base.org CHAIN_ID=84532 JOBS_CONTRACT=0x…
 *   EVALUATOR_PRIVATE_KEY=0x…   (needs a little Base Sepolia ETH for gas)
 *   E2E_BUYER_PRIVATE_KEY=0x…   (needs ≥ 1 test USDC: https://faucet.circle.com)
 *   E2E_SELLER_ADDRESS=0x…      (optional; defaults to a fresh random address)
 *   npm run chain:e2e
 */
import { createDb } from "@proofdesk/db";
import { createPublicClient, erc20Abi, getAddress, type Hex, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAccountWithKey } from "../apps/api/src/accounts.ts";
import { createApp } from "../apps/api/src/app.ts";
import { loadEnv } from "../apps/api/src/load-env.ts";
import { chainFromEnv } from "../apps/api/src/models.ts";

loadEnv();
const chain = chainFromEnv();
const buyerKey = process.env.E2E_BUYER_PRIVATE_KEY as Hex | undefined;
if (!chain || !buyerKey) {
  console.error(
    "Set CHAIN_RPC_URL, CHAIN_ID, JOBS_CONTRACT, EVALUATOR_PRIVATE_KEY and E2E_BUYER_PRIVATE_KEY.",
  );
  process.exit(1);
}
const cfg = await chain.config();
if (cfg.mode === "live") {
  console.error("Refusing to run against mainnet. Use Base Sepolia (CHAIN_ID=84532).");
  process.exit(1);
}

const buyer = privateKeyToAccount(buyerKey);
const seller = getAddress(
  process.env.E2E_SELLER_ADDRESS ?? privateKeyToAccount(generatePrivateKey()).address,
);
const pub = createPublicClient({ transport: http(process.env.CHAIN_RPC_URL) });
const balance = (who: Hex) =>
  pub.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const handle = createDb("memory://");
await handle.migrate();
const platform = await createAccountWithKey(handle.db, { name: "e2e platform" });
const ops = await createAccountWithKey(handle.db, { name: "e2e ops", scopes: ["ops"] });
let clock = new Date();
const app = createApp({ db: handle.db, now: () => clock, chain });
// biome-ignore lint/suspicious/noExplicitAny: script responses are checked field by field
async function call(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path}: ${JSON.stringify(json.error)}`);
  return json;
}

const AMOUNT = 1_000_000; // 1 USDC
console.log(`chain ${cfg.chainId}  contract ${cfg.contract}  token ${cfg.token}`);
console.log(`buyer ${buyer.address}  seller ${seller}  evaluator ${cfg.evaluator}`);
const before = { buyer: await balance(buyer.address), seller: await balance(seller) };
if (before.buyer < BigInt(AMOUNT)) {
  console.error(`The buyer needs at least 1 USDC (has ${before.buyer}).`);
  process.exit(1);
}

await call(platform.apiKey, "PUT", "/v1/sellers/e2e_seller/wallet", { address: seller });
const agr = await call(platform.apiKey, "POST", "/v1/agreements", {
  buyer_ref: "e2e_buyer",
  seller_ref: "e2e_seller",
  spec: {
    version: 1,
    title: "Chain e2e",
    request: "End-to-end test of the stablecoin rail.",
    vertical: "translation",
    criteria: [{ id: "done", description: "The file is delivered", check: "deterministic" }],
    amount: { value: AMOUNT, currency: "usdc" },
    delivery_due_at: new Date(Date.now() + 86_400_000).toISOString(),
    appeal_window_hours: 1,
  },
});
await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
  spec_hash: agr.spec_hash,
});

const f = await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/onchain-job`, {
  client: buyer.address,
});
const td = f.typed_data;
const signature = await buyer.signTypedData({
  domain: td.domain,
  types: { ReceiveWithAuthorization: td.types.ReceiveWithAuthorization },
  primaryType: "ReceiveWithAuthorization",
  message: {
    ...td.message,
    value: BigInt(td.message.value),
    validAfter: BigInt(td.message.validAfter),
    validBefore: BigInt(td.message.validBefore),
  },
});
const funded = await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/onchain-job/authorization`, {
  client: buyer.address,
  valid_before: td.message.validBefore,
  signature,
});
console.log(`✓ funded: job ${funded.job.job_id}, tx ${funded.job.fund_tx}`);

await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/deliveries`, {
  artifacts: [{ name: "out.txt", media_type: "text/plain", content: "done" }],
});
await call(ops.apiKey, "POST", `/v1/ops/agreements/${agr.id}/start-verification`);
await call(ops.apiKey, "POST", `/v1/ops/agreements/${agr.id}/decide`, {
  outcome: { kind: "partial", release_percent: 60 },
  reason: "e2e",
});
clock = new Date(Date.now() + 2 * 3_600_000); // past the 1h appeal window
const settled = await call(ops.apiKey, "POST", `/v1/ops/agreements/${agr.id}/settle`, {});
const job = await call(platform.apiKey, "GET", `/v1/agreements/${agr.id}/onchain-job`);
console.log(`✓ settled: ${settled.status}, tx ${job.settle_tx}`);

const after = { buyer: await balance(buyer.address), seller: await balance(seller) };
const s = job.settlement;
const sellerGot = after.seller - before.seller;
const buyerNet = before.buyer - after.buyer;
const ok = sellerGot === BigInt(s.seller_payout) && buyerNet === BigInt(s.release);
console.log(
  `${ok ? "✓" : "✗"} balances: seller +${sellerGot} (expected ${s.seller_payout}), buyer -${buyerNet} net (expected ${s.release})`,
);
const ledger = await call(ops.apiKey, "GET", "/v1/ops/ledger/verify");
console.log(`${ledger.ok ? "✓" : "✗"} ledger chain intact`);
await handle.close();
process.exit(ok && ledger.ok ? 0 : 1);
