import { type Db, schema } from "@proofdesk/db";
import { gte } from "drizzle-orm";

const pct = (sorted: number[], p: number) =>
  sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) : 0;

/** Verification volume, escalations, latency and model cost per vertical over a window. */
export async function verificationStats(db: Db, since: Date) {
  const rows = await db
    .select({
      engine: schema.verifications.engineVersion,
      action: schema.verifications.action,
      cost: schema.verifications.costUsd,
      report: schema.verifications.report,
    })
    .from(schema.verifications)
    .where(gte(schema.verifications.createdAt, since));
  const by = new Map<string, { n: number; escalated: number; cost: number; ms: number[] }>();
  for (const r of rows) {
    const vertical = r.engine.split("-v")[0] ?? r.engine;
    const s = by.get(vertical) ?? { n: 0, escalated: 0, cost: 0, ms: [] };
    s.n++;
    if (r.action === "escalate") s.escalated++;
    s.cost += r.cost;
    const ms = (r.report as { latency_ms?: number }).latency_ms;
    if (typeof ms === "number") s.ms.push(ms);
    by.set(vertical, s);
  }
  return {
    since: since.toISOString(),
    verticals: [...by].map(([vertical, s]) => {
      const sorted = s.ms.sort((a, b) => a - b);
      return {
        vertical,
        checks: s.n,
        escalated: s.escalated,
        escalation_rate: s.n ? s.escalated / s.n : 0,
        latency_ms: { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95) },
        cost_usd: {
          total: Math.round(s.cost * 10_000) / 10_000,
          per_check: s.n ? s.cost / s.n : 0,
        },
      };
    }),
  };
}
