/**
 * Checks a Proof Desk ledger proof offline, trusting nothing Proof Desk says:
 * 1. recomputes every entry's hash from its fields;
 * 2. proves each entry is in the ledger tree head (RFC 6962 inclusion proof);
 * 3. with --rpc, reads the LedgerAnchor contract and checks that exact tree head was posted.
 *
 *   npx tsx scripts/verify-proof.ts proof.json [--rpc https://sepolia.base.org]
 *
 * Get proof.json from a verdict report ("download the proof") or GET /v1/agreements/:id/proof.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ledgerAnchorAbi } from "@proofdesk/chain";
import { type LedgerProof, verifyLedgerProof } from "@proofdesk/core";
import { createPublicClient, getAddress, http } from "viem";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rpc: { type: "string" } },
});
const file = positionals[0];
if (!file) {
  console.error("usage: verify-proof.ts proof.json [--rpc URL]");
  process.exit(2);
}
const proof = JSON.parse(readFileSync(file, "utf8")) as LedgerProof;
const { ok, problems } = verifyLedgerProof(proof);
console.log(
  `${ok ? "✓" : "✗"} ${proof.entries.length} ledger entries of ${proof.agreement_id} are in tree head #${proof.tree.size} (root ${proof.tree.root.slice(0, 16)}…)`,
);
for (const p of problems) console.log(`  ✗ ${p}`);
if (proof.verdict) {
  const record = JSON.parse(proof.verdict.entry.payload) as {
    subject: string;
    outcome: { kind: string };
  };
  const bad = problems.some((p) => p.includes("verdict"));
  console.log(
    `${bad ? "✗" : "✓"} public verdict record ${record.subject.slice(0, 16)}… (${record.outcome.kind}) is this agreement's, sealed at ledger #${proof.verdict.entry.seq}`,
  );
} else {
  console.log("- no public verdict record yet (sealed daily once the agreement is final)");
}

let anchored = true;
const a = proof.tree.anchor;
if (!a) {
  console.log(
    "! this tree head isn't anchored on-chain yet; ask for the proof again after the next anchor",
  );
  anchored = false;
} else if (values.rpc) {
  const pub = createPublicClient({ transport: http(values.rpc) });
  const chainId = await pub.getChainId();
  if (chainId !== a.chain_id) {
    console.log(`✗ the RPC is chain ${chainId}, the anchor is on chain ${a.chain_id}`);
    anchored = false;
  } else {
    const address = getAddress(a.contract);
    const count = await pub.readContract({ address, abi: ledgerAnchorAbi, functionName: "count" });
    let found = false;
    for (let i = count; i > 0n && !found; i--) {
      const x = await pub.readContract({
        address,
        abi: ledgerAnchorAbi,
        functionName: "get",
        args: [i - 1n],
      });
      if (Number(x.seq) === proof.tree.size) found = x.headHash === `0x${proof.tree.root}`;
    }
    anchored = found;
    console.log(
      found
        ? `✓ tree head #${proof.tree.size} is posted on chain ${chainId} at ${address}`
        : `✗ no anchor at ${address} on chain ${chainId} matches tree head #${proof.tree.size}`,
    );
  }
} else {
  console.log(
    `- anchored on chain ${a.chain_id} at ${a.contract} (tx ${a.tx_hash}); pass --rpc to check it on-chain`,
  );
}
process.exit(ok && anchored ? 0 : 1);
