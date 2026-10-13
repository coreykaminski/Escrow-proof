/**
 * Data retention: once an agreement is final (settled or cancelled) and its retention period
 * has passed, the documents are deleted: delivered files, buyer inputs, and the parts of
 * verification reports that quote them (evidence, test output, quotes, cited URLs). Every hash
 * stays, so the ledger, the Merkle proofs and the public verdict records still verify; the
 * ledger never held content in the first place. A platform can also ask for it early (e.g. a
 * data-subject request) once the agreement is final.
 */

import { appendLedgerEntry, type Db, schema } from "@proofdesk/db";
import type { AnyReport, BaseReport } from "@proofdesk/verifier";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import { type AgreementRow, lockAgreement, type Scope } from "./agreements.ts";

export const DEFAULT_RETENTION_DAYS = 90;
const GONE = "(deleted after the retention period)";

/**
 * A report with everything that could quote the documents removed, in the same shape (so
 * pages and clients keep working): verdicts, confidences, finding kinds, counts and the
 * decision stay.
 */
export function redactReport(report: AnyReport): AnyReport & { redacted: true } {
  const base: BaseReport = {
    engine_version: report.engine_version,
    decision: report.decision,
    usage: report.usage,
    latency_ms: report.latency_ms,
    findings: report.findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      confidence: f.confidence,
      message: GONE,
    })),
    criteria: report.criteria.map((c) => ({ ...c, signals: [] })),
  };
  const out: Record<string, unknown> = { ...base, redacted: true };
  if ("vertical" in report && report.vertical === "code") {
    out.vertical = "code";
    out.tests = {
      ...report.tests,
      log: "",
      cases: report.tests.cases.map((tc) => ({
        name: tc.name,
        criterion_id: tc.criterion_id,
        status: tc.status,
      })),
    };
  } else if ("vertical" in report && report.vertical === "data") {
    out.vertical = "data";
    out.data = {
      format: report.data.format,
      records: report.data.records,
      schema_errors: [],
      citations: [],
      quotes: [],
    };
  } else if ("languages" in report) {
    out.languages = report.languages;
  }
  return out as unknown as AnyReport & { redacted: true };
}

export async function deleteAgreementContent(
  db: Db,
  p: { agreementId: string; scope: Scope; reason: "retention" | "request"; now: Date },
): Promise<AgreementRow> {
  return db.transaction(async (tx) => {
    const a = await lockAgreement(tx, p.agreementId, p.scope);
    if (a.contentDeletedAt) return a;
    if (a.status !== "settled" && a.status !== "cancelled") {
      throw new ApiError(
        409,
        "not_final",
        `documents can only be deleted once the agreement is settled or cancelled (it's "${a.status}")`,
      );
    }
    const deliveries = await tx
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.agreementId, a.id));
    for (const d of deliveries) {
      await tx
        .update(schema.deliveries)
        .set({ artifacts: d.artifacts.map((x) => ({ ...x, content: "" })) })
        .where(eq(schema.deliveries.id, d.id));
    }
    const inputs = await tx
      .update(schema.agreementInputs)
      .set({ content: "" })
      .where(eq(schema.agreementInputs.agreementId, a.id))
      .returning({ id: schema.agreementInputs.id });
    const verifications = await tx
      .select()
      .from(schema.verifications)
      .where(eq(schema.verifications.agreementId, a.id));
    for (const v of verifications) {
      // report_hash keeps the hash of the original report (it's on the ledger).
      await tx
        .update(schema.verifications)
        .set({ report: redactReport(v.report as AnyReport) })
        .where(eq(schema.verifications.id, v.id));
    }
    const [row] = await tx
      .update(schema.agreements)
      .set({ contentDeletedAt: p.now, updatedAt: p.now })
      .where(eq(schema.agreements.id, a.id))
      .returning();
    await appendLedgerEntry(tx, {
      agreementId: a.id,
      type: "agreement.content_deleted",
      payload: {
        reason: p.reason,
        deliveries: deliveries.length,
        artifacts: deliveries.reduce((n, d) => n + d.artifacts.length, 0),
        inputs: inputs.length,
        verifications: verifications.length,
      },
      createdAt: p.now,
    });
    return row as AgreementRow;
  });
}

/** Deletes the documents of every final agreement past its account's retention period. */
export async function deleteExpiredContent(
  db: Db,
  p: { now: Date; defaultDays?: number },
): Promise<{ deleted: string[] }> {
  const days = sql<number>`coalesce(${schema.accounts.retentionDays}, ${p.defaultDays ?? DEFAULT_RETENTION_DAYS})`;
  const finalAt = sql`coalesce(${schema.agreements.settledAt}, ${schema.agreements.cancelledAt}, ${schema.agreements.updatedAt})`;
  const due = await db
    .select({ id: schema.agreements.id })
    .from(schema.agreements)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.agreements.accountId))
    .where(
      and(
        inArray(schema.agreements.status, ["settled", "cancelled"]),
        isNull(schema.agreements.contentDeletedAt),
        sql`${finalAt} + make_interval(days => ${days}) <= ${p.now.toISOString()}::timestamptz`,
      ),
    );
  const deleted: string[] = [];
  for (const { id } of due) {
    await deleteAgreementContent(db, {
      agreementId: id,
      scope: {},
      reason: "retention",
      now: p.now,
    });
    deleted.push(id);
  }
  return { deleted };
}

export function retentionDaysFromEnv(env = process.env): number | null {
  if (env.RETENTION_DAYS === "off") return null;
  const n = Number(env.RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_RETENTION_DAYS;
}
