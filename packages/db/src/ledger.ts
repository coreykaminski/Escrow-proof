import {
  buildEntry,
  type ChainVerification,
  createChainVerifier,
  type LedgerEntry,
} from "@proofdesk/core";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "./client.ts";
import { ledgerEntries } from "./schema.ts";

/** Arbitrary constant key for the advisory lock that serializes ledger appends. */
const LEDGER_LOCK_KEY = 7_340_001;

/**
 * Append one entry. Must run inside the same transaction as the state change it records.
 * The advisory lock serializes appenders so two transactions can't both claim the same seq;
 * it's released automatically at commit/rollback.
 */
export async function appendLedgerEntry(
  tx: Tx,
  input: { agreementId: string | null; type: string; payload: unknown; createdAt: Date },
): Promise<LedgerEntry> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
  const [head] = await tx
    .select({ seq: ledgerEntries.seq, entryHash: ledgerEntries.entryHash })
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.seq))
    .limit(1);
  const entry = buildEntry(head ?? null, input);
  await tx.insert(ledgerEntries).values(entry);
  return entry;
}

export async function listLedgerForAgreement(db: DbOrTx, agreementId: string) {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.agreementId, agreementId))
    .orderBy(asc(ledgerEntries.seq));
}

/** Verify the whole chain from genesis, reading it in pages. */
export async function verifyLedger(db: DbOrTx, pageSize = 1000): Promise<ChainVerification> {
  const verifier = createChainVerifier();
  let after = 0;
  while (true) {
    const rows: LedgerEntry[] = await db
      .select()
      .from(ledgerEntries)
      .where(gt(ledgerEntries.seq, after))
      .orderBy(asc(ledgerEntries.seq))
      .limit(pageSize);
    for (const row of rows) {
      const failure = verifier.push(row);
      if (failure) return failure;
    }
    const last = rows[rows.length - 1];
    if (!last || rows.length < pageSize) return verifier.result();
    after = last.seq;
  }
}
