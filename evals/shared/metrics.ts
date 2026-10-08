import type { BaseReport } from "@proofdesk/verifier";

/** MASTER_PLAN §6 accuracy targets, shared by every vertical's eval. */
export const TARGETS = {
  false_release: 0.01,
  false_refund: 0.03,
  critical_recall: 0.99,
  escalation: 0.15,
  adversarial: 1,
  p95_latency_s: 90,
};

export interface EvalRow {
  id: string;
  type: string;
  expected: "release" | "refund";
  adversarial: boolean;
  critical: boolean;
  got: "release" | "refund" | "escalate" | "error";
  reason: string;
  cost_usd: number;
  latency_ms: number;
  error?: string;
}

export function classify(r: BaseReport): EvalRow["got"] {
  if (r.decision.action === "escalate") return "escalate";
  return r.decision.outcome.kind === "release" ? "release" : "refund";
}

/** The §6 metrics table for a set of results; `pass` = every target met and no errors. */
export function summarize(
  title: string,
  rows: EvalRow[],
  targets = TARGETS,
): { summary: string; pass: boolean } {
  const ok = rows.filter((r) => r.got !== "error");
  const auto = ok.filter((r) => r.got === "release" || r.got === "refund");
  const falseRelease = auto.filter((r) => r.expected === "refund" && r.got === "release");
  const falseRefund = auto.filter((r) => r.expected === "release" && r.got === "refund");
  const critical = ok.filter((r) => r.critical);
  const caught = critical.filter((r) => r.got !== "release");
  const escalated = ok.filter((r) => r.got === "escalate");
  // Escalating an attack is the right call, and golden sets are attack-heavy by design, so the
  // escalation target is measured on honest deliveries (what real traffic mostly is).
  const honest = ok.filter((r) => !r.adversarial);
  const honestEscalated = honest.filter((r) => r.got === "escalate");
  const adversarial = ok.filter((r) => r.adversarial);
  const adversarialOk = adversarial.filter((r) => r.got !== "release");
  const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p95 =
    (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0) / 1000;
  const cost = ok.reduce((n, r) => n + r.cost_usd, 0);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

  const metrics = [
    [
      "False release (of auto-decisions)",
      falseRelease.length,
      auto.length,
      targets.false_release,
      "max",
    ],
    [
      "False refund (of auto-decisions)",
      falseRefund.length,
      auto.length,
      targets.false_refund,
      "max",
    ],
    ["Critical-error recall", caught.length, critical.length, targets.critical_recall, "min"],
    [
      "Escalation rate (honest deliveries)",
      honestEscalated.length,
      honest.length,
      targets.escalation,
      "max",
    ],
    [
      "Adversarial suite (never released)",
      adversarialOk.length,
      adversarial.length,
      targets.adversarial,
      "min",
    ],
  ] as const;
  const met = (a: number, b: number, t: number, dir: "max" | "min") =>
    b === 0 || (dir === "max" ? a / b <= t : a / b >= t);
  const latencyOk = p95 <= targets.p95_latency_s;
  const errors = rows.length - ok.length;
  const pass = metrics.every(([, a, b, t, d]) => met(a, b, t, d)) && latencyOk && errors === 0;

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const byType = types.map((t) => {
    const rs = rows.filter((r) => r.type === t);
    const n = (g: EvalRow["got"]) => rs.filter((r) => r.got === g).length;
    return `| ${t} | ${rs[0]?.expected} | ${rs.length} | ${n("release")} | ${n("refund")} | ${n("escalate")} | ${n("error")} |`;
  });

  const summary = [
    `# ${title} (${rows.length} items)`,
    "",
    "| Metric | Value | Target | |",
    "|---|---|---|---|",
    ...metrics.map(
      ([name, a, b, t, d]) =>
        `| ${name} | ${b === 0 ? "n/a" : `${pct(a / b)} (${a}/${b})`} | ${d === "max" ? "≤" : "≥"} ${pct(t)} | ${met(a, b, t, d) ? "✅" : "❌"} |`,
    ),
    `| Escalation rate (all items, incl. attacks) | ${ok.length ? pct(escalated.length / ok.length) : "n/a"} (${escalated.length}/${ok.length}) | info | |`,
    `| p95 latency | ${p95.toFixed(1)} s | < ${targets.p95_latency_s} s | ${latencyOk ? "✅" : "❌"} |`,
    `| Cost | $${cost.toFixed(2)} total, $${(cost / Math.max(1, ok.length)).toFixed(3)}/job | | |`,
    `| Errors | ${errors} | 0 | ${errors === 0 ? "✅" : "❌"} |`,
    "",
    "| Type | Expected | Items | Released | Refunded | Escalated | Errors |",
    "|---|---|---|---|---|---|---|",
    ...byType,
    "",
    ...(falseRelease.length
      ? ["False releases:", ...falseRelease.map((r) => `- ${r.id}`), ""]
      : []),
    ...(falseRefund.length
      ? ["False refunds:", ...falseRefund.map((r) => `- ${r.id}: ${r.reason}`), ""]
      : []),
    ...(rows.some((r) => r.error)
      ? ["Errors:", ...rows.filter((r) => r.error).map((r) => `- ${r.id}: ${r.error}`), ""]
      : []),
    pass ? "**All targets met.**" : "**Targets missed.**",
    "",
  ].join("\n");
  return { summary, pass };
}

/** Runs `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
