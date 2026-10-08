import type { AnchorGateway } from "@proofdesk/chain";
import { appendLedgerEntry, type Db, schema, verifyLedger } from "@proofdesk/db";
import { desc, eq, gt } from "drizzle-orm";
import { getState, setState } from "./status.ts";

export type AnchorResult =
  | { status: "empty" }
  | { status: "current"; seq: number }
  | { status: "anchored"; seq: number; head_hash: string; tx_hash: string };

/**
 * Posts the ledger head to the LedgerAnchor contract, after re-verifying the whole hash chain
 * (never vouch for a broken chain). The anchor is itself recorded on the ledger, so the next
 * anchor covers it too.
 */
export async function anchorLedger(db: Db, gw: AnchorGateway, now: Date): Promise<AnchorResult> {
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
  const { txHash } = await gw.anchor(verified.headSeq, verified.headHash);
  const record = {
    seq: verified.headSeq,
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
  return {
    status: "anchored",
    seq: verified.headSeq,
    head_hash: verified.headHash,
    tx_hash: txHash,
  };
}

/** Checks every on-chain anchor against the database: the entry at that seq must have that hash. */
export async function verifyAnchors(db: Db, gw: AnchorGateway) {
  const anchors = await gw.list();
  const results = [];
  for (const a of anchors) {
    const [entry] = await db
      .select({ entryHash: schema.ledgerEntries.entryHash })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.seq, a.seq));
    results.push({
      seq: a.seq,
      anchored_at: new Date(a.timestamp * 1000).toISOString(),
      ok: entry?.entryHash === a.headHash,
      ...(entry ? {} : { problem: "no ledger entry at this seq" }),
      ...(entry && entry.entryHash !== a.headHash
        ? { problem: "hash differs from the anchor" }
        : {}),
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
        tx_hash: String(s.value.tx_hash),
        chain_id: Number(s.value.chain_id),
        contract: String(s.value.contract),
        at: s.updatedAt,
      }
    : null;
}
