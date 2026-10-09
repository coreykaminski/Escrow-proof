import { appealWindowEndsAt } from "@proofdesk/core";
import { type Db, listLedgerForAgreement, schema, verifyLedger } from "@proofdesk/db";
import type { AnyReport, BaseReport } from "@proofdesk/verifier";
import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  type AgreementRow,
  getAgreement,
  listDeliveries,
  type Scope,
  snapshotOf,
} from "./agreements.ts";
import { listInputs } from "./inputs.ts";
import { getHold } from "./payments.ts";
import { listVerifications } from "./verification.ts";

export interface CaseFile {
  agreement: AgreementRow;
  appealEndsAt: Date | null;
  inputs: Awaited<ReturnType<typeof listInputs>>;
  delivery: Awaited<ReturnType<typeof listDeliveries>>[number] | null;
  verification:
    | (Awaited<ReturnType<typeof listVerifications>>[number] & { report: AnyReport })
    | null;
  disputes: (typeof schema.disputes.$inferSelect)[];
  decisions: (typeof schema.decisions.$inferSelect)[];
  hold: Awaited<ReturnType<typeof getHold>> | null;
  ledger: Awaited<ReturnType<typeof listLedgerForAgreement>>;
}

/** Everything a reviewer (or the owning platform) needs to see about one agreement. */
export async function loadCaseFile(db: Db, agreementId: string, scope: Scope): Promise<CaseFile> {
  const agreement = await getAgreement(db, agreementId, scope);
  const [inputs, deliveries, verifications, disputes, decisions, hold, ledger] = await Promise.all([
    listInputs(db, agreement.id),
    listDeliveries(db, agreement.id),
    listVerifications(db, agreement.id),
    db
      .select()
      .from(schema.disputes)
      .where(eq(schema.disputes.agreementId, agreement.id))
      .orderBy(asc(schema.disputes.openedAt)),
    db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.agreementId, agreement.id))
      .orderBy(asc(schema.decisions.createdAt)),
    getHold(db, agreement.id),
    listLedgerForAgreement(db, agreement.id),
  ]);
  const latest = verifications[0];
  return {
    agreement,
    appealEndsAt: appealWindowEndsAt(snapshotOf(agreement)),
    inputs,
    delivery: deliveries[0] ?? null,
    verification: latest ? { ...latest, report: latest.report as AnyReport } : null,
    disputes,
    decisions,
    hold: hold ?? null,
    ledger,
  };
}

/**
 * Cases waiting on a human: escalated by the verifier, disputed, or (shadow mode) an automatic
 * decision held for review. Oldest first.
 */
export async function reviewQueue(db: Db) {
  const rows = await db
    .select()
    .from(schema.agreements)
    .where(
      or(
        inArray(schema.agreements.status, ["escalated", "disputed"]),
        and(eq(schema.agreements.status, "decided"), eq(schema.agreements.reviewPending, true)),
      ),
    )
    .orderBy(asc(schema.agreements.updatedAt));
  const ids = rows.map((r) => r.id);
  const [openDisputes, verifications] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(schema.disputes)
          .where(
            and(inArray(schema.disputes.agreementId, ids), eq(schema.disputes.status, "open")),
          ),
        db
          .select()
          .from(schema.verifications)
          .where(inArray(schema.verifications.agreementId, ids))
          .orderBy(desc(schema.verifications.createdAt)),
      ])
    : [[], []];
  return rows.map((a) => {
    const dispute = openDisputes.find((d) => d.agreementId === a.id);
    const verification = verifications.find((v) => v.agreementId === a.id);
    const verifierReason = (verification?.report as BaseReport | undefined)?.decision.reason;
    const reason = dispute
      ? `Dispute by ${dispute.openedBy}: ${dispute.reason}`
      : a.reviewPending
        ? `Shadow review of an automatic ${a.outcome?.kind ?? ""}: ${verifierReason ?? ""}`
        : (verifierReason ?? "Escalated");
    return { agreement: a, reason, waitingSince: a.updatedAt };
  });
}

/** Human decisions per reviewer (each reviewer has their own ops key), for review payouts. */
export async function reviewerStats(db: Db, since: Date) {
  return db
    .select({
      apiKeyId: schema.decisions.actorRef,
      reviewer: schema.accounts.name,
      decisions: count(),
      disputeResolutions:
        sql<number>`count(*) filter (where ${schema.decisions.kind} = 'dispute_resolution')`.mapWith(
          Number,
        ),
      lastDecisionAt: sql<Date>`max(${schema.decisions.createdAt})`.mapWith((v) => new Date(v)),
    })
    .from(schema.decisions)
    .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.decisions.actorRef))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.apiKeys.accountId))
    .where(
      and(
        eq(schema.decisions.decidedBy, "human"),
        sql`${schema.decisions.createdAt} >= ${since.toISOString()}`,
      ),
    )
    .groupBy(schema.decisions.actorRef, schema.accounts.name)
    .orderBy(desc(count()));
}

/** Whole-chain verification, for the "ledger intact" badge on reports. */
export async function ledgerIntact(db: Db): Promise<boolean> {
  return (await verifyLedger(db)).ok;
}
