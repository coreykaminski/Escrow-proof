import { sameOutcome } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import { and, asc, eq, gte, inArray } from "drizzle-orm";

/** Below this many automatic decisions a vertical's numbers aren't published (noise, privacy). */
export const MIN_SAMPLE = 20;

export interface VerticalAccuracy {
  vertical: string;
  verifications: number;
  auto_decisions: number;
  escalated: number;
  disputed: number;
  /** Automatic decisions a human checked in a pilot's shadow review. */
  reviewed: number;
  /** Automatic decisions a human later changed, on shadow review or on dispute. */
  overturned: number;
  escalation_rate: number | null;
  overturn_rate: number | null;
  published: boolean;
}

/**
 * Production accuracy over a window, live mode only, aggregated per vertical. An automatic
 * decision counts as overturned when a shadow review or a dispute resolution changed it. Verticals
 * with fewer than MIN_SAMPLE automatic decisions show counts but no rates.
 */
export async function accuracyReport(db: Db, p: { since: Date }) {
  const runs = await db
    .select({ v: schema.verifications, a: schema.agreements })
    .from(schema.verifications)
    .innerJoin(schema.agreements, eq(schema.agreements.id, schema.verifications.agreementId))
    .where(and(eq(schema.agreements.livemode, true), gte(schema.verifications.createdAt, p.since)));
  const ids = [...new Set(runs.map((r) => r.a.id))];
  const decisions = ids.length
    ? await db
        .select()
        .from(schema.decisions)
        .where(inArray(schema.decisions.agreementId, ids))
        .orderBy(asc(schema.decisions.createdAt))
    : [];
  const reviewed = new Set(
    ids.length
      ? (
          await db
            .select({ decisionId: schema.decisionReviews.decisionId })
            .from(schema.decisionReviews)
            .where(inArray(schema.decisionReviews.agreementId, ids))
        ).map((r) => r.decisionId)
      : [],
  );

  const byVertical = new Map<string, VerticalAccuracy>();
  const row = (v: string) => {
    let r = byVertical.get(v);
    if (!r) {
      r = {
        vertical: v,
        verifications: 0,
        auto_decisions: 0,
        escalated: 0,
        disputed: 0,
        reviewed: 0,
        overturned: 0,
        escalation_rate: null,
        overturn_rate: null,
        published: false,
      };
      byVertical.set(v, r);
    }
    return r;
  };
  for (const { v, a } of runs) {
    const r = row(a.spec.vertical);
    r.verifications++;
    if (v.action === "escalate") r.escalated++;
  }
  for (const id of ids) {
    const mine = decisions.filter((d) => d.agreementId === id);
    const auto = mine.find((d) => d.decidedBy === "auto" && d.kind === "verification");
    if (!auto) continue;
    const vertical = runs.find((r) => r.a.id === id)?.a.spec.vertical ?? "general";
    const r = row(vertical);
    r.auto_decisions++;
    const later = (kind: string) =>
      mine.find((d) => d.kind === kind && d.createdAt >= auto.createdAt);
    const override = later("review_override");
    const resolution = later("dispute_resolution");
    if (reviewed.has(auto.id)) r.reviewed++;
    if (resolution) r.disputed++;
    // The last human word on the outcome is what the automatic decision is judged against.
    const final = resolution ?? override;
    if (final && !sameOutcome(final.outcome, auto.outcome)) r.overturned++;
  }
  const verticals = [...byVertical.values()].map((r) => {
    const published = r.auto_decisions >= MIN_SAMPLE;
    return {
      ...r,
      published,
      escalation_rate: published && r.verifications ? r.escalated / r.verifications : null,
      overturn_rate: published ? r.overturned / r.auto_decisions : null,
    };
  });
  return { since: p.since.toISOString(), min_sample: MIN_SAMPLE, verticals };
}
