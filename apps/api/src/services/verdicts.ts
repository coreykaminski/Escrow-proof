/**
 * Sealing content-free verdict records (core/verdict.ts) into the ledger, and the public feed.
 * Final (settled) live agreements are sealed in a daily batch: every record in a batch shares
 * one timestamp and is shuffled, so neither time nor order links a record to a transaction.
 */
import { randomBytes, randomInt } from "node:crypto";
import { buildVerdictRecord, type Outcome } from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema } from "@proofdesk/db";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";

export async function sealVerdicts(db: Db, now: Date): Promise<{ sealed: number }> {
  const due = await db
    .select({ a: schema.agreements })
    .from(schema.agreements)
    .leftJoin(schema.verdictSeals, eq(schema.verdictSeals.agreementId, schema.agreements.id))
    .where(
      and(
        eq(schema.agreements.status, "settled"),
        eq(schema.agreements.livemode, true),
        isNull(schema.verdictSeals.agreementId),
      ),
    );
  if (due.length === 0) return { sealed: 0 };
  // Fisher-Yates with crypto randomness: ledger order says nothing about settlement order.
  const batch = due.map((d) => d.a);
  for (let i = batch.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [batch[i], batch[j]] = [batch[j] as (typeof batch)[number], batch[i] as (typeof batch)[number]];
  }

  await db.transaction(async (tx) => {
    for (const a of batch) {
      const [decision] = await tx
        .select({ decidedBy: schema.decisions.decidedBy })
        .from(schema.decisions)
        .where(eq(schema.decisions.agreementId, a.id))
        .orderBy(desc(schema.decisions.createdAt), desc(schema.decisions.id))
        .limit(1);
      const salt = randomBytes(32).toString("hex");
      const record = buildVerdictRecord({
        saltHex: salt,
        agreementId: a.id,
        outcome: a.outcome as Outcome,
        decidedBy: decision?.decidedBy ?? "auto",
        finalAt: a.settledAt ?? now,
      });
      const entry = await appendLedgerEntry(tx, {
        agreementId: null,
        type: "verdict.sealed",
        payload: record,
        createdAt: now,
      });
      await tx.insert(schema.verdictSeals).values({
        agreementId: a.id,
        salt,
        subject: record.subject,
        ledgerSeq: entry.seq,
        sealedAt: now,
      });
    }
  });
  return { sealed: batch.length };
}

export async function getSeal(db: Db, agreementId: string) {
  const [row] = await db
    .select()
    .from(schema.verdictSeals)
    .where(eq(schema.verdictSeals.agreementId, agreementId));
  return row;
}

/** Sealed verdict entries after `after` (a ledger seq), oldest first. */
export async function verdictEntries(db: Db, after: number, limit: number) {
  return db
    .select()
    .from(schema.ledgerEntries)
    .where(
      and(eq(schema.ledgerEntries.type, "verdict.sealed"), gt(schema.ledgerEntries.seq, after)),
    )
    .orderBy(asc(schema.ledgerEntries.seq))
    .limit(limit);
}
