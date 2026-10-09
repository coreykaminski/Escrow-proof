/**
 * Shadow mode (MASTER_PLAN §8, test layer 7): during a pilot, every automatic decision for the
 * account is held until a human reviewer confirms or overrides it. Nothing settles unreviewed.
 * The reviews double as production accuracy data, and every disagreement is exported as a
 * golden-set candidate so the verifier is re-tested on it forever (rule 2: every false verdict
 * becomes a permanent test case).
 */
import { appealWindowEndsAt, type Outcome } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import type { BaseReport } from "@proofdesk/verifier";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import { type AgreementRow, applyEvent, outcomeToJson, snapshotOf } from "./agreements.ts";
import { listInputs } from "./inputs.ts";

export type ReviewRow = typeof schema.decisionReviews.$inferSelect;

export async function setShadowMode(db: Db, accountId: string, enabled: boolean) {
  const [row] = await db
    .update(schema.accounts)
    .set({ shadowMode: enabled })
    .where(eq(schema.accounts.id, accountId))
    .returning();
  if (!row) throw new ApiError(404, "not_found", "account not found");
  return row;
}

/** Confirm (outcome null or unchanged) or override a held automatic decision. */
export async function reviewDecision(
  db: Db,
  p: {
    agreementId: string;
    outcome: Outcome | null;
    reason: string;
    reviewerKeyId: string;
    now: Date;
  },
): Promise<{ agreement: AgreementRow; review: ReviewRow }> {
  const agreement = await applyEvent(db, {
    agreementId: p.agreementId,
    scope: {},
    event: { type: "REVIEW", outcome: p.outcome, reason: p.reason },
    actor: { role: "ops", ref: p.reviewerKeyId },
    now: p.now,
  });
  const [review] = await db
    .select()
    .from(schema.decisionReviews)
    .where(eq(schema.decisionReviews.agreementId, p.agreementId))
    .orderBy(desc(schema.decisionReviews.createdAt), desc(schema.decisionReviews.id))
    .limit(1);
  if (!review) throw new Error("review was not recorded");
  return { agreement, review };
}

/** Held automatic decisions, the one whose appeal window closes first at the top. */
export async function pendingReviews(db: Db) {
  const rows = await db
    .select()
    .from(schema.agreements)
    .where(and(eq(schema.agreements.status, "decided"), eq(schema.agreements.reviewPending, true)))
    .orderBy(asc(schema.agreements.decidedAt));
  return rows.map((agreement) => ({
    agreement,
    appealEndsAt: appealWindowEndsAt(snapshotOf(agreement)),
  }));
}

export async function listReviews(
  db: Db,
  opts: { agreed?: boolean; since?: Date; limit: number },
): Promise<ReviewRow[]> {
  const where = [];
  if (opts.agreed !== undefined) where.push(eq(schema.decisionReviews.agreed, opts.agreed));
  if (opts.since) where.push(gte(schema.decisionReviews.createdAt, opts.since));
  return db
    .select()
    .from(schema.decisionReviews)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(schema.decisionReviews.createdAt), desc(schema.decisionReviews.id))
    .limit(opts.limit);
}

export function reviewJson(r: ReviewRow) {
  return {
    id: r.id,
    object: "decision_review",
    agreement_id: r.agreementId,
    decision_id: r.decisionId,
    verification_id: r.verificationId,
    auto_outcome: outcomeToJson(r.autoOutcome),
    reviewed_outcome: outcomeToJson(r.reviewedOutcome),
    agreed: r.agreed,
    override_decision_id: r.overrideDecisionId,
    reviewer: r.reviewerRef,
    reason: r.reason,
    created_at: r.createdAt.toISOString(),
  };
}

/**
 * How the automatic decisions held up under review, per vertical. The error definitions match
 * the golden-set metrics (§6): a false release paid out (in full or part) for work the reviewer
 * refused; a false refund refused work the reviewer would have paid for.
 */
export async function shadowStats(db: Db, since: Date) {
  const rows = await db
    .select({ review: schema.decisionReviews, vertical: schema.agreements.spec })
    .from(schema.decisionReviews)
    .innerJoin(schema.agreements, eq(schema.agreements.id, schema.decisionReviews.agreementId))
    .where(gte(schema.decisionReviews.createdAt, since));
  const pays = (o: Outcome) => o.kind !== "refund";
  const byVertical = new Map<
    string,
    { reviewed: number; agreed: number; false_release: number; false_refund: number }
  >();
  for (const { review, vertical } of rows) {
    const v = vertical.vertical;
    const s = byVertical.get(v) ?? { reviewed: 0, agreed: 0, false_release: 0, false_refund: 0 };
    s.reviewed++;
    if (review.agreed) s.agreed++;
    if (pays(review.autoOutcome) && !pays(review.reviewedOutcome)) s.false_release++;
    if (!pays(review.autoOutcome) && pays(review.reviewedOutcome)) s.false_refund++;
    byVertical.set(v, s);
  }
  return {
    object: "shadow_stats",
    since: since.toISOString(),
    verticals: [...byVertical].map(([vertical, s]) => ({
      vertical,
      ...s,
      agreement_rate: s.reviewed ? s.agreed / s.reviewed : null,
    })),
  };
}

/**
 * Disagreements as golden-set candidates: everything the verifier saw (spec, source inputs,
 * the delivery it judged) labelled with the reviewer's outcome. One JSON object per line.
 * They contain customer content: pilot agreements must allow this use, and a person still
 * curates each one into the vertical's golden set (evals/<vertical>/).
 */
export async function goldenCandidates(db: Db, opts: { since?: Date; limit: number }) {
  const reviews = await listReviews(db, { ...opts, agreed: false });
  if (reviews.length === 0) return [];
  const ids = reviews.map((r) => r.agreementId);
  const verificationIds = reviews.flatMap((r) => (r.verificationId ? [r.verificationId] : []));
  const [agreements, verifications] = await Promise.all([
    db.select().from(schema.agreements).where(inArray(schema.agreements.id, ids)),
    verificationIds.length
      ? db
          .select()
          .from(schema.verifications)
          .where(inArray(schema.verifications.id, verificationIds))
      : [],
  ]);
  const deliveryIds = verifications.map((v) => v.deliveryId);
  const deliveries = deliveryIds.length
    ? await db.select().from(schema.deliveries).where(inArray(schema.deliveries.id, deliveryIds))
    : [];

  const out = [];
  for (const r of reviews) {
    const a = agreements.find((x) => x.id === r.agreementId);
    if (!a) continue;
    const v = verifications.find((x) => x.id === r.verificationId);
    const d = v ? deliveries.find((x) => x.id === v.deliveryId) : undefined;
    const report = v?.report as BaseReport | undefined;
    const inputs = await listInputs(db, a.id);
    out.push({
      id: `shadow-${r.id}`,
      source: "shadow_review",
      vertical: a.spec.vertical,
      spec: a.spec,
      inputs: inputs.map((i) => ({ name: i.name, media_type: i.mediaType, content: i.content })),
      deliverable: (d?.artifacts ?? []).map((x) => ({
        name: x.name,
        media_type: x.mediaType,
        content: x.content,
      })),
      label: {
        outcome: outcomeToJson(r.reviewedOutcome),
        reason: r.reason,
        reviewer: r.reviewerRef,
      },
      verifier: {
        outcome: outcomeToJson(r.autoOutcome),
        engine_version: v?.engineVersion ?? null,
        confidence: v?.confidence ?? null,
        reason: report?.decision.reason ?? null,
        failed_criteria: (report?.criteria ?? [])
          .filter((c) => c.verdict === "fail")
          .map((c) => c.criterion_id),
      },
      reviewed_at: r.createdAt.toISOString(),
    });
  }
  return out;
}
