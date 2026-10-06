/**
 * Verification Engine eval: runs the full translation verifier over the golden set and checks
 * the MASTER_PLAN §6 targets. Calls Claude (costs money); responses are cached on disk by request
 * hash, so re-running unchanged items is free.
 *
 *   npm run eval:translation -- [--sample 60] [--types meaning,minor] [--concurrency 6] [--no-cache]
 *
 * Writes evals/translation/runs/<timestamp>/{results.jsonl,summary.md}. Exits 1 if a target is missed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ClaudeCaller,
  type StructuredCaller,
  type VerificationReport,
  verifyTranslation,
} from "@proofdesk/verifier";
import { z } from "zod";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import { type GoldenItem, mulberry32, shuffle } from "./golden.ts";
import { mapLimit } from "./llm.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const TARGETS = {
  false_release: 0.01,
  false_refund: 0.03,
  critical_recall: 0.99,
  escalation: 0.15,
  adversarial: 1,
  p95_latency_s: 90,
};

/** Caches structured responses on disk, keyed by everything that shapes the request. */
function cached(inner: StructuredCaller, dir: string): StructuredCaller {
  mkdirSync(dir, { recursive: true });
  return {
    async call(params) {
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            params.model,
            params.effort,
            params.system,
            params.user,
            z.toJSONSchema(params.schema),
          ]),
        )
        .digest("hex");
      const file = join(dir, `${key}.json`);
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
      const result = await inner.call(params);
      writeFileSync(file, JSON.stringify(result));
      return result;
    },
  };
}

interface Row {
  id: string;
  type: string;
  expected: "release" | "refund";
  adversarial: boolean;
  critical: boolean;
  got: "release" | "refund" | "escalate" | "error";
  reason: string;
  cost_usd: number;
  latency_ms: number;
  report?: VerificationReport;
  error?: string;
}

function classify(r: VerificationReport): Row["got"] {
  if (r.decision.action === "escalate") return "escalate";
  return r.decision.outcome.kind === "release" ? "release" : "refund";
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      sample: { type: "string" },
      types: { type: "string" },
      concurrency: { type: "string", default: "6" },
      "no-cache": { type: "boolean", default: false },
      seed: { type: "string", default: "1" },
    },
  });
  let items: GoldenItem[] = readFileSync(join(here, "golden.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const typeOf = (i: GoldenItem) => i.expected.errors[0]?.type ?? "clean";
  if (values.types) {
    const types = new Set(values.types.split(","));
    items = items.filter((i) => types.has(typeOf(i)));
  }
  if (values.sample) {
    // Stratified: keep every type's share, in a seeded order.
    const n = Number(values.sample);
    const rand = mulberry32(Number(values.seed));
    const byType = new Map<string, GoldenItem[]>();
    for (const i of shuffle(items, rand))
      byType.set(typeOf(i), [...(byType.get(typeOf(i)) ?? []), i]);
    const picked: GoldenItem[] = [];
    for (const group of byType.values()) {
      picked.push(...group.slice(0, Math.max(1, Math.round((group.length * n) / items.length))));
    }
    items = picked;
  }

  const real = new ClaudeCaller();
  const caller = values["no-cache"] ? real : cached(real, join(here, ".cache"));
  console.log(`Verifying ${items.length} golden items…`);

  const rows = await mapLimit(items, Number(values.concurrency), async (item): Promise<Row> => {
    const base = {
      id: item.id,
      type: typeOf(item),
      expected: item.expected.outcome,
      adversarial: item.adversarial,
      critical: item.expected.errors.some((e) => e.severity === "critical"),
    };
    const started = Date.now();
    try {
      const report = await verifyTranslation(
        {
          spec: item.spec,
          source: item.source,
          target: item.target,
          sourceLang: item.pair.source,
          targetLang: item.pair.target,
        },
        { caller, rand: mulberry32(item.id.length) },
      );
      const row: Row = {
        ...base,
        got: classify(report),
        reason: report.decision.reason,
        cost_usd: report.usage.cost_usd,
        latency_ms: Date.now() - started,
        report,
      };
      const mark = row.got === "escalate" ? "?" : row.got === row.expected ? "✓" : "✗";
      console.log(`  ${mark} ${item.id} → ${row.got}`);
      return row;
    } catch (err) {
      console.log(`  ! ${item.id} → error: ${err instanceof Error ? err.message : err}`);
      return {
        ...base,
        got: "error",
        reason: "",
        cost_usd: 0,
        latency_ms: Date.now() - started,
        error: String(err),
      };
    }
  });

  const { summary, pass } = summarize(rows);
  const out = join(here, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "results.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  writeFileSync(join(out, "summary.md"), summary);
  console.log(`\n${summary}\nWrote ${out}`);
  process.exitCode = pass ? 0 : 1;
}

export function summarize(rows: Row[]): { summary: string; pass: boolean } {
  const ok = rows.filter((r) => r.got !== "error");
  const auto = ok.filter((r) => r.got === "release" || r.got === "refund");
  const falseRelease = auto.filter((r) => r.expected === "refund" && r.got === "release");
  const falseRefund = auto.filter((r) => r.expected === "release" && r.got === "refund");
  const critical = ok.filter((r) => r.critical);
  const caught = critical.filter((r) => r.got !== "release");
  const escalated = ok.filter((r) => r.got === "escalate");
  const adversarial = ok.filter((r) => r.adversarial);
  const adversarialOk = adversarial.filter((r) => r.got !== "release");
  const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p95 =
    (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0) / 1000;
  const cost = ok.reduce((n, r) => n + r.cost_usd, 0);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

  /** [name, numerator, denominator, target, direction]; an empty denominator is n/a. */
  const metrics = [
    [
      "False release (of auto-decisions)",
      falseRelease.length,
      auto.length,
      TARGETS.false_release,
      "max",
    ],
    [
      "False refund (of auto-decisions)",
      falseRefund.length,
      auto.length,
      TARGETS.false_refund,
      "max",
    ],
    ["Critical-error recall", caught.length, critical.length, TARGETS.critical_recall, "min"],
    ["Escalation rate", escalated.length, ok.length, TARGETS.escalation, "max"],
    [
      "Adversarial suite (never released)",
      adversarialOk.length,
      adversarial.length,
      TARGETS.adversarial,
      "min",
    ],
  ] as const;
  const met = (a: number, b: number, t: number, dir: "max" | "min") =>
    b === 0 || (dir === "max" ? a / b <= t : a / b >= t);
  const latencyOk = p95 <= TARGETS.p95_latency_s;
  const errors = rows.length - ok.length;
  const pass = metrics.every(([, a, b, t, d]) => met(a, b, t, d)) && latencyOk && errors === 0;

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const byType = types.map((t) => {
    const rs = rows.filter((r) => r.type === t);
    const n = (g: Row["got"]) => rs.filter((r) => r.got === g).length;
    return `| ${t} | ${rs[0]?.expected} | ${rs.length} | ${n("release")} | ${n("refund")} | ${n("escalate")} | ${n("error")} |`;
  });

  const summary = [
    `# Translation verifier eval (${rows.length} items)`,
    "",
    "| Metric | Value | Target | |",
    "|---|---|---|---|",
    ...metrics.map(
      ([name, a, b, t, d]) =>
        `| ${name} | ${b === 0 ? "n/a" : `${pct(a / b)} (${a}/${b})`} | ${d === "max" ? "≤" : "≥"} ${pct(t)} | ${met(a, b, t, d) ? "✅" : "❌"} |`,
    ),
    `| p95 latency | ${p95.toFixed(1)} s | < ${TARGETS.p95_latency_s} s | ${latencyOk ? "✅" : "❌"} |`,
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
    pass ? "**All targets met.**" : "**Targets missed.**",
    "",
  ].join("\n");
  return { summary, pass };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) await main();
