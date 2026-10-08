/**
 * Stablecoin rail (Part 7) through the API against FakeChainGateway, which enforces the
 * ProofDeskJobs contract's rules in memory. The real contract runs in contracts/ (Foundry) and
 * packages/chain/test/anvil.test.ts.
 */
import { FakeChainGateway, type JobTerms } from "@proofdesk/chain";
import { FakeGateway } from "@proofdesk/payments";
import type { WalletTypedData } from "@proofdesk/sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

const DAY = 24 * HOUR;
const BUYER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const SELLER_WALLET = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const BUDGET = 180_000_000; // 180 USDC

let h: Harness;
let chain: FakeChainGateway;

afterEach(async () => {
  await h?.close();
});

async function setup(opts: { card?: boolean } = {}) {
  h = await createHarness({
    chain: (now) => {
      chain = new FakeChainGateway(undefined, now);
      return chain;
    },
    ...(opts.card ? { payments: (now) => new FakeGateway({ now }) } : {}),
  });
}

const A = () => h.keys.platformA;
const O = () => h.keys.ops;
const usdcSpec = (over: Record<string, unknown> = {}) =>
  specFixture({ amount: { value: BUDGET, currency: "usdc" }, ...over });

async function approved(opts: { wallet?: boolean; spec?: Record<string, unknown> } = {}) {
  if (opts.wallet !== false) {
    const w = await h.call(A(), "PUT", "/v1/sellers/agent_translator_7/wallet", {
      address: SELLER_WALLET,
    });
    expect(w.status).toBe(200);
  }
  const agr = (
    await h.call(A(), "POST", "/v1/agreements", {
      buyer_ref: "user_buyer_1",
      seller_ref: "agent_translator_7",
      spec: opts.spec ?? usdcSpec(),
    })
  ).body;
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  return agr.id as string;
}

/** The terms the API issued, as the buyer's wallet would submit them. */
function walletTerms(f: { terms: Record<string, string | number> }, client: Address): JobTerms {
  return {
    client,
    provider: f.terms.provider as Address,
    evaluator: f.terms.evaluator as Address,
    expiredAt: BigInt(f.terms.expired_at as number),
    description: f.terms.description as string,
    budget: BigInt(f.terms.budget as string),
  };
}

async function fundedByWallet(id: string) {
  const f = (await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`)).body;
  const tx = chain.fundFromWallet(walletTerms(f, BUYER.address));
  const res = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
    tx_hash: tx,
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function decide(id: string, outcome: Record<string, unknown>) {
  await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
    artifacts: [{ name: "out.txt", media_type: "text/plain", content: "done" }],
  });
  await h.call(O(), "POST", `/v1/ops/agreements/${id}/start-verification`);
  const res = await h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, {
    outcome,
    reason: "reviewed",
  });
  expect(res.status).toBe(200);
}

const tick = async () => (await h.call(O(), "POST", "/v1/ops/run-due")).body;
const ledger = async (id: string) =>
  (await h.call(A(), "GET", `/v1/agreements/${id}/ledger`)).body.data as {
    type: string;
    entry_hash: string;
  }[];

describe("seller wallets", () => {
  it("sets, replaces and reads a checksummed payout address", async () => {
    await setup();
    const lower = SELLER_WALLET.toLowerCase();
    const set = await h.call(A(), "PUT", "/v1/sellers/s1/wallet", { address: lower });
    expect(set.body.address).toBe(SELLER_WALLET);
    await h.call(A(), "PUT", "/v1/sellers/s1/wallet", { address: BUYER.address });
    expect((await h.call(A(), "GET", "/v1/sellers/s1/wallet")).body.address).toBe(BUYER.address);
    expect((await h.call(h.keys.platformB, "GET", "/v1/sellers/s1/wallet")).status).toBe(404);
    expect((await h.call(A(), "PUT", "/v1/sellers/s1/wallet", { address: "0x1234" })).status).toBe(
      400,
    );
  });
});

describe("funding terms", () => {
  it("issues fixed terms bound to the agreement and its approved spec", async () => {
    await setup();
    const id = await approved();
    const res = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`, {
      client: BUYER.address,
    });
    expect(res.status).toBe(201);
    const f = res.body;
    const agr = (await h.call(A(), "GET", `/v1/agreements/${id}`)).body;
    expect(f).toMatchObject({
      object: "onchain_funding",
      chain_id: 84532,
      network: "base-sepolia",
      terms: {
        provider: SELLER_WALLET,
        budget: String(BUDGET),
        description: `proofdesk:v1:${id}:${agr.spec_hash}`,
      },
    });
    // Expiry covers delivery + a day to verify + the appeal window + a week for review.
    const due = new Date(agr.delivery_due_at).getTime();
    expect(f.terms.expired_at * 1000).toBe(due + DAY + 72 * HOUR + 7 * DAY);
    expect(f.calls.map((c: { description: string }) => c.description)).toEqual([
      "Approve the job contract to take the budget",
      "Create and fund the job",
    ]);
    expect(f.typed_data).toMatchObject({
      primaryType: "ReceiveWithAuthorization",
      message: { from: BUYER.address, value: String(BUDGET) },
    });
    // Same terms on every call, so a signature stays valid.
    h.clock.advance(HOUR);
    const again = (await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`)).body;
    expect(again.terms).toEqual(f.terms);
  });

  it("needs USDC, a seller wallet, an approved spec, and a matching mode", async () => {
    await setup();
    const usd = await approved({ spec: specFixture() });
    expect((await h.call(A(), "POST", `/v1/agreements/${usd}/onchain-job`)).body.error.code).toBe(
      "unsupported_currency",
    );
    const noWallet = await (async () => {
      const agr = (
        await h.call(A(), "POST", "/v1/agreements", {
          buyer_ref: "b",
          seller_ref: "no_wallet_seller",
          spec: usdcSpec(),
        })
      ).body;
      await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
        spec_hash: agr.spec_hash,
      });
      return agr.id;
    })();
    expect(
      (await h.call(A(), "POST", `/v1/agreements/${noWallet}/onchain-job`)).body.error.code,
    ).toBe("seller_wallet_missing");
    const draft = (
      await h.call(A(), "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "agent_translator_7",
        spec: usdcSpec(),
      })
    ).body;
    expect(
      (await h.call(A(), "POST", `/v1/agreements/${draft.id}/onchain-job`)).body.error.code,
    ).toBe("invalid_transition");

    const live = h.keys.live;
    await h.call(live, "PUT", "/v1/sellers/s/wallet", { address: SELLER_WALLET });
    const la = (
      await h.call(live, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: usdcSpec(),
      })
    ).body;
    await h.call(live, "POST", `/v1/agreements/${la.id}/approve-spec`, { spec_hash: la.spec_hash });
    expect(
      (await h.call(live, "POST", `/v1/agreements/${la.id}/onchain-job`)).body.error.code,
    ).toBe("livemode_mismatch");
  });

  it("returns 503 when the chain isn't configured", async () => {
    h = await createHarness();
    const res = await h.call(A(), "POST", "/v1/agreements/agr_x/onchain-job");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("chain_unavailable");
  });

  it("can't mix card and on-chain funding on one agreement", async () => {
    await setup({ card: true });
    const id = await approved();
    await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`);
    const card = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
      payment_method: "pm_card_visa",
    });
    expect(card.body.error.code).toBe("already_funding");
  });
});

describe("funding", () => {
  it("wallet funding is verified on-chain before the agreement funds", async () => {
    await setup();
    const id = await approved();
    const body = await fundedByWallet(id);
    expect(body.agreement.status).toBe("funded");
    expect(body.agreement.hold).toMatchObject({
      rail: "onchain",
      ref: `84532:${(await chain.config()).contract}:1`,
    });
    expect(body.job).toMatchObject({ status: "funded", job_id: "1", client: BUYER.address });
    const types = (await ledger(id)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["onchain_job.terms_issued", "onchain_job.funded", "agreement.fund"]),
    );
    // Confirming the same transaction again is harmless.
    const again = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
      tx_hash: body.job.fund_tx,
    });
    expect(again.status).toBe(200);
  });

  it("rejects transactions that aren't a matching funding of our contract", async () => {
    await setup();
    const id = await approved();
    const f = (await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`)).body;
    const unknown = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
      tx_hash: `0x${"ab".repeat(32)}`,
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("funding_not_found");

    // A job with the seller's address but a smaller budget doesn't fund the agreement.
    const cheap = chain.fundFromWallet({ ...walletTerms(f, BUYER.address), budget: 1n });
    const res = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
      tx_hash: cheap,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "terms_mismatch" });
    expect(res.body.error.message).toContain("budget");

    // Nor does another agreement's job.
    const other = await approved();
    const of = (await h.call(A(), "POST", `/v1/agreements/${other}/onchain-job`)).body;
    const otherTx = chain.fundFromWallet(walletTerms(of, BUYER.address));
    const cross = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
      tx_hash: otherTx,
    });
    expect(cross.body.error.message).toContain("description");
    expect((await h.call(A(), "GET", `/v1/agreements/${id}`)).body.status).toBe("spec_approved");
  });

  it("gasless: the buyer signs, Proof Desk relays, and the signature can't be replayed", async () => {
    await setup();
    const id = await approved();
    const f = (
      await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`, { client: BUYER.address })
    ).body;
    const td = f.typed_data;
    const signature = await BUYER.signTypedData({
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
    const body = {
      client: BUYER.address,
      valid_before: td.message.validBefore,
      signature,
    };
    const forged = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/authorization`, {
      ...body,
      client: SELLER_WALLET.replace("90F7", "90F8"),
    });
    expect(forged.status).toBe(422);
    expect(forged.body.error.code).toBe("authorization_rejected");

    const res = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/authorization`, body);
    expect(res.status).toBe(201);
    expect(res.body.agreement.status).toBe("funded");
    expect(res.body.job.client).toBe(BUYER.address);

    const replay = await h.call(
      A(),
      "POST",
      `/v1/agreements/${id}/onchain-job/authorization`,
      body,
    );
    expect(replay.body.error.code).toBe("already_funded");
  });

  it("funding after the delivery deadline is refunded on-chain right away", async () => {
    await setup();
    const id = await approved();
    const f = (await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`)).body;
    h.clock.advance(5 * DAY); // past delivery_due_at (T0 + 4 days)
    const tx = chain.fundFromWallet(walletTerms(f, BUYER.address));
    const res = await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job/confirm`, {
      tx_hash: tx,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("deadline_passed");
    expect(chain.settlements).toHaveLength(1);
    expect(chain.settlements[0]?.releaseBP).toBe(0);
    expect(chain.balances.get(BUYER.address)).toBe(BigInt(BUDGET));
    expect((await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body.status).toBe(
      "settled",
    );
  });
});

describe("settlement", () => {
  it("a partial decision settles on-chain with the decision's ledger hash as the reason", async () => {
    await setup();
    const id = await approved();
    await fundedByWallet(id);
    await decide(id, { kind: "partial", release_percent: 60 });
    expect((await tick()).settled).toEqual([]); // appeal window open
    h.clock.advance(73 * HOUR);
    const due = await tick();
    expect(due.settled).toEqual([id]);

    const decision = (await ledger(id)).find((e) => e.type === "agreement.decide");
    expect(chain.settlements).toEqual([
      expect.objectContaining({ jobId: 1n, releaseBP: 6000, reason: `0x${decision?.entry_hash}` }),
    ]);
    const released = (BUDGET * 60) / 100;
    const fee = (released * 200) / 10_000;
    expect(chain.balances.get(SELLER_WALLET)).toBe(BigInt(released - fee));
    expect(chain.balances.get(BUYER.address)).toBe(BigInt(BUDGET - released));

    const job = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    expect(job.status).toBe("settled");
    expect(job.settlement).toMatchObject({
      release_bp: 6000,
      seller_payout: released - fee,
      buyer_refund: BUDGET - released,
      fee,
    });
    const agr = (await h.call(A(), "GET", `/v1/agreements/${id}`)).body;
    expect(agr.status).toBe("settled");
    expect((await ledger(id)).map((e) => e.type)).toContain("onchain_job.settled");
  });

  it("a retry after an RPC failure finishes the settlement once", async () => {
    await setup();
    const id = await approved();
    await fundedByWallet(id);
    await decide(id, { kind: "release" });
    h.clock.advance(73 * HOUR);
    const { ChainError } = await import("@proofdesk/chain");
    chain.failNextSettle = new ChainError("rpc down", true, "rpc_error");
    const first = await tick();
    expect(first.settled).toEqual([]);
    expect(first.errors[0]).toMatchObject({ agreement_id: id });
    expect((await tick()).settled).toEqual([id]);
    expect(chain.settlements).toHaveLength(1);
    expect(await tick()).toMatchObject({ settled: [] });
  });

  it("settles early, ignoring the open appeal window, when the job is about to expire", async () => {
    await setup();
    const id = await approved({ spec: usdcSpec({ appeal_window_hours: 24 * 30 }) });
    await fundedByWallet(id);
    await decide(id, { kind: "release" });
    const job = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    expect((await tick()).settled).toEqual([]);
    h.clock.now = new Date(new Date(job.expires_at).getTime() - 12 * HOUR);
    expect((await tick()).settled).toEqual([id]);
    expect(chain.settlements[0]?.releaseBP).toBe(10_000);
  });

  it("warns ops when an undecided agreement's job is about to expire", async () => {
    await setup();
    const id = await approved();
    await fundedByWallet(id);
    await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
      artifacts: [{ name: "out.txt", media_type: "text/plain", content: "done" }],
    });
    await h.call(O(), "POST", `/v1/ops/agreements/${id}/start-verification`);
    const job = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    h.clock.now = new Date(new Date(job.expires_at).getTime() - 6 * HOUR);
    const due = await tick();
    expect(due.errors).toEqual([
      expect.objectContaining({ agreement_id: id, code: "onchain_expiry_near" }),
    ]);
  });

  it("a job the buyer reclaimed after expiry is recorded; only a refund decision can settle it", async () => {
    await setup();
    const id = await approved();
    await fundedByWallet(id);
    await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
      artifacts: [{ name: "out.txt", media_type: "text/plain", content: "done" }],
    });
    await h.call(O(), "POST", `/v1/ops/agreements/${id}/start-verification`);
    const job = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    h.clock.now = new Date(new Date(job.expires_at).getTime() + HOUR);
    chain.claimRefund(1n);
    expect((await tick()).onchain_expired).toEqual([id]);

    await h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, {
      outcome: { kind: "release" },
      reason: "late review",
    });
    const blocked = await h.call(O(), "POST", `/v1/ops/agreements/${id}/settle`, { force: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("hold_unsettleable");
  });
});

describe("hosted page and x402", () => {
  async function payLink(id: string) {
    const res = await h.call(A(), "POST", `/v1/agreements/${id}/payment-links`, {
      rail: "onchain",
    });
    expect(res.status).toBe(201);
    return new URL(res.body.url).pathname;
  }

  it("serves the USDC page, typed data, and funds from a relayed signature", async () => {
    await setup();
    const id = await approved();
    const path = await payLink(id);
    const page = await h.fetch(`http://x${path}`);
    const html = await page.text();
    expect(html).toContain("Connect wallet and authorize");
    expect(html).toContain("base-sepolia");
    expect(html).not.toContain("<script>"); // values go through data attributes only

    const td = (await (
      await h.fetch(`http://x${path}/onchain/typed-data?client=${BUYER.address}`)
    ).json()) as WalletTypedData & {
      domain: { verifyingContract: Address };
    };
    expect(td.types.EIP712Domain).toHaveLength(4);
    const signature = await BUYER.signTypedData({
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
    const res = await h.call(null, "POST", `${path}/onchain/authorize`, {
      client: BUYER.address,
      valid_after: td.message.validAfter,
      valid_before: td.message.validBefore,
      signature,
    });
    expect(res.body).toEqual({ status: "funded" });
    expect(await (await h.fetch(`http://x${path}`)).text()).toContain("Funded");
  });

  it("x402: 402 with requirements, then X-PAYMENT funds the job", async () => {
    await setup();
    const id = await approved();
    const path = await payLink(id);
    const first = await h.call(null, "GET", `${path}/x402`);
    expect(first.status).toBe(402);
    const req = first.body.accepts[0];
    expect(first.body.x402Version).toBe(1);
    expect(req).toMatchObject({
      scheme: "erc8183-job",
      network: "base-sepolia",
      maxAmountRequired: String(BUDGET),
      payTo: (await chain.config()).contract,
      extra: { authorization: "ReceiveWithAuthorization" },
    });

    const td = (await (
      await h.fetch(`http://x${path}/onchain/typed-data?client=${BUYER.address}`)
    ).json()) as WalletTypedData & {
      domain: { verifyingContract: Address };
    };
    const message = {
      from: BUYER.address,
      to: td.message.to as Address,
      value: BigInt(td.message.value),
      validAfter: 0n,
      validBefore: BigInt(td.message.validBefore),
      nonce: td.message.nonce as Hex,
    };
    const signature = await BUYER.signTypedData({
      domain: td.domain,
      types: { ReceiveWithAuthorization: td.types.ReceiveWithAuthorization },
      primaryType: "ReceiveWithAuthorization",
      message,
    });
    const header = (value: bigint) =>
      Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: "erc8183-job",
          network: "base-sepolia",
          payload: {
            signature,
            authorization: {
              ...message,
              value: value.toString(),
              validAfter: "0",
              validBefore: message.validBefore.toString(),
            },
          },
        }),
      ).toString("base64");

    const wrong = await h.call(null, "POST", `${path}/x402`, undefined, {
      "X-PAYMENT": header(1n),
    });
    expect(wrong.status).toBe(402);
    expect(wrong.body.error).toContain("exactly");

    const paid = await h.call(null, "POST", `${path}/x402`, undefined, {
      "X-PAYMENT": header(message.value),
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("funded");
    const receipt = JSON.parse(
      Buffer.from(paid.headers.get("X-PAYMENT-RESPONSE") ?? "", "base64").toString(),
    );
    expect(receipt).toMatchObject({ success: true, network: "base-sepolia", payer: BUYER.address });

    // Asking again just reports the funded job.
    const after = await h.call(null, "GET", `${path}/x402`);
    expect(after.status).toBe(200);
    expect(after.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
  });
});
