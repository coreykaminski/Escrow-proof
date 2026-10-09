import type { AnchorGateway } from "@proofdesk/chain";
import { MERKLE_SCHEME, rootFrom, rootOf, toHex } from "@proofdesk/core";
import {
  appendLedgerEntry,
  type Db,
  ledgerLeaves,
  schema,
  verifyLedger,
  withLedgerTree,
} from "@proofdesk/db";
import { desc, gt } from "drizzle-orm";
import { getState, setState } from "./status.ts";
import { sealVerdicts } from "./verdicts.ts";

export type AnchorResult =
  | { status: "empty" }
  | { status: "current"; seq: number }
  | { status: "anchored"; seq: number; root: string; tx_hash: string };

/**
 * Posts the ledger's Merkle tree head (RFC 6962: size + root over every entry hash) to the
 * LedgerAnchor contract, after re-verifying the whole hash chain (never vouch for a broken
 * chain). The contract's (seq, hash) slot holds (tree size, root). The anchor is itself
 * recorded on the ledger, so the next anchor covers it too.
 */
export async function anchorLedger(db: Db, gw: AnchorGateway, now: Date): Promise<AnchorResult> {
  // Seal the day's final verdicts first, so the anchored tree head covers their records.
  await sealVerdicts(db, now);
  const [head] = await db
    .select({ seq: schema.ledgerEntries.seq })
    .from(schema.ledgerEntries)
    .orderBy(desc(schema.ledgerEntries.seq))
    .limit(1);
  if (!head) return { status: "empty" };
  const latest = await gw.latest();
  if (latest) {
    // Nothing new but our own "anchored" records: don't anchor just to cover the anchor.
    const since = await db
      .select({ type: schema.ledgerEntries.type })
      .from(schema.ledgerEntries)
      .where(gt(schema.ledgerEntries.seq, latest.seq));
    if (since.every((e) => e.type === "ledger.anchored")) {
      return { status: "current", seq: latest.seq };
    }
  }

  const verified = await verifyLedger(db);
  if (!verified.ok) {
    throw new Error(`ledger verification failed at seq ${verified.seq}; not anchoring`);
  }
  // Recompute the root from the entries themselves, independent of the stored subtrees, and
  // refuse to anchor if the two disagree (the cache must never decide what gets vouched for).
  const root = toHex(rootOf(await ledgerLeaves(db, verified.headSeq)));
  const cached = toHex(await withLedgerTree(db, (get) => rootFrom(get, verified.headSeq)));
  if (cached !== root) {
    throw new Error("stored ledger tree nodes disagree with the ledger; not anchoring");
  }
  const { txHash } = await gw.anchor(verified.headSeq, root);
  const record = {
    scheme: MERKLE_SCHEME,
    seq: verified.headSeq,
    root,
    head_hash: verified.headHash,
    tx_hash: txHash,
    chain_id: gw.chainId,
    contract: gw.contract,
  };
  await setState(db, "ledger.anchor", record, now);
  await db.transaction(async (tx) => {
    await appendLedgerEntry(tx, {
      agreementId: null,
      type: "ledger.anchored",
      payload: record,
      createdAt: now,
    });
  });
  return { status: "anchored", seq: verified.headSeq, root, tx_hash: txHash };
}

/**
 * Checks every on-chain anchor against the database: the Merkle root of the first `seq`
 * entries must equal the anchored root. Matching every anchor also proves each later tree
 * extends the earlier ones (nothing anchored was rewritten).
 */
export async function verifyAnchors(db: Db, gw: AnchorGateway) {
  const anchors = await gw.list();
  const all = await ledgerLeaves(db);
  const results = [];
  for (const a of anchors) {
    const present = a.seq <= all.length;
    const root = present ? toHex(rootOf(all.slice(0, a.seq))) : null;
    results.push({
      seq: a.seq,
      anchored_at: new Date(a.timestamp * 1000).toISOString(),
      ok: root === a.headHash,
      ...(present ? {} : { problem: "the ledger is shorter than this anchor" }),
      ...(present && root !== a.headHash ? { problem: "root differs from the anchor" } : {}),
    });
  }
  return {
    ok: results.every((r) => r.ok),
    chain_id: gw.chainId,
    contract: gw.contract,
    anchors: results,
  };
}

/** The last anchor recorded by this deployment (for reports and status). */
export async function lastAnchor(db: Db) {
  const s = await getState(db, "ledger.anchor");
  return s
    ? {
        seq: Number(s.value.seq),
        /** Merkle root of the first `seq` entries (absent on anchors from before Merkle heads). */
        root: typeof s.value.root === "string" ? s.value.root : null,
        tx_hash: String(s.value.tx_hash),
        chain_id: Number(s.value.chain_id),
        contract: String(s.value.contract),
        at: s.updatedAt,
      }
    : null;
}
