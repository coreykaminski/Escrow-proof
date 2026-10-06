/**
 * Spec Engine eval (Part 2 gate: ≥90% of drafted criteria human-rated "testable").
 *
 *   npm run eval:spec -- [--limit N] [--concurrency 4] [--only tr-01,cd-05]
 *
 * Drafts criteria for each request in requests.jsonl (calls Claude, costs money), then writes
 * runs/<timestamp>/ with:
 *   results.jsonl   every draft, its validation and lint result
 *   review.csv      one row per criterion; fill the `testable` column with y/n
 *   summary.md      automatic metrics (validity, lint, vertical accuracy, tokens, cost)
 * Then score the human ratings with: npm run eval:spec:score -- runs/<timestamp>/review.csv
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { lintSpec, type Spec, type SpecWarning, type Vertical } from "@proofdesk/core";
import {
  assembleSpec,
  ClaudeSpecDrafter,
  type DraftResult,
  PROMPT_VERSION,
  SpecDraftError,
} from "@proofdesk/spec-engine";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import { toCsv } from "./csv.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** USD per million tokens, for the cost estimate only. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

interface EvalRequest {
  id: string;
  vertical: Vertical;
  request: string;
}

interface EvalResult {
  id: string;
  expected_vertical: Vertical;
  request: string;
  ok: boolean;
  error?: string;
  draft?: DraftResult;
  valid_spec?: boolean;
  /** The assembled spec (normalized ids), when the draft formed a valid one. */
  spec?: Spec;
  invalid_reason?: string;
  warnings?: SpecWarning[];
  ms: number;
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      only: { type: "string" },
      model: { type: "string" },
    },
  });

  let requests: EvalRequest[] = readFileSync(join(here, "requests.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (values.only) {
    const ids = new Set(values.only.split(","));
    requests = requests.filter((r) => ids.has(r.id));
  }
  if (values.limit) requests = requests.slice(0, Number(values.limit));

  const model = values.model ?? process.env.SPEC_DRAFT_MODEL;
  const drafter = new ClaudeSpecDrafter(model ? { model } : {});
  console.log(`Drafting ${requests.length} requests with ${drafter.model} (${PROMPT_VERSION})…`);

  const results = await mapLimit(requests, Number(values.concurrency), async (r) => {
    const started = Date.now();
    const result = await runOne(drafter, r);
    const mark = result.ok ? (result.valid_spec ? "✓" : "✗ invalid") : `✗ ${result.error}`;
    console.log(`  ${r.id} ${mark} (${Date.now() - started} ms)`);
    return result;
  });

  const outDir = join(here, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.jsonl"),
    `${results.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  writeFileSync(join(outDir, "review.csv"), reviewCsv(results));
  const summary = summarize(results, drafter.model);
  writeFileSync(join(outDir, "summary.md"), summary);
  console.log(`\n${summary}\nWrote ${outDir}`);
}

async function runOne(drafter: ClaudeSpecDrafter, r: EvalRequest): Promise<EvalResult> {
  const started = Date.now();
  const base = { id: r.id, expected_vertical: r.vertical, request: r.request };
  let draft: DraftResult;
  try {
    // The vertical is withheld so the run also measures how well the drafter classifies.
    draft = await drafter.draft({ request: r.request });
  } catch (err) {
    const msg = err instanceof SpecDraftError ? `${err.code}: ${err.message}` : String(err);
    return { ...base, ok: false, error: msg, ms: Date.now() - started };
  }
  // Placeholder terms: only the drafted parts are under test.
  try {
    const spec = assembleSpec(draft.output, {
      request: r.request,
      amount: { value: 10_000, currency: "usd" },
      delivery_due_at: "2030-01-01T00:00:00Z",
    });
    return {
      ...base,
      ok: true,
      draft,
      valid_spec: true,
      spec,
      warnings: lintSpec(spec),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ...base,
      ok: true,
      draft,
      valid_spec: false,
      invalid_reason: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  }
}

function reviewCsv(results: EvalResult[]): string {
  const rows: (string | number | boolean)[][] = [
    [
      "request_id",
      "criterion_id",
      "check",
      "critical",
      "description",
      "verification",
      "lint",
      "testable",
      "note",
    ],
  ];
  for (const r of results) {
    for (const c of r.spec?.criteria ?? r.draft?.output.criteria ?? []) {
      const lint = (r.warnings ?? [])
        .filter((w) => w.criterion_id === c.id)
        .map((w) => w.code)
        .join(" ");
      rows.push([
        r.id,
        c.id,
        c.check,
        c.critical,
        c.description,
        c.verification ?? "",
        lint,
        "",
        "",
      ]);
    }
  }
  return toCsv(rows);
}

function summarize(results: EvalResult[], model: string): string {
  const drafted = results.filter((r) => r.draft);
  const criteria = drafted.flatMap((r) => r.draft?.output.criteria ?? []);
  const warnings = drafted.flatMap((r) => r.warnings ?? []);
  const perCriterionFlagged = drafted.reduce((n, r) => {
    const ids = new Set((r.warnings ?? []).map((w) => w.criterion_id).filter(Boolean));
    return n + ids.size;
  }, 0);
  const tokensIn = drafted.reduce((n, r) => n + (r.draft?.meta.input_tokens ?? 0), 0);
  const tokensOut = drafted.reduce((n, r) => n + (r.draft?.meta.output_tokens ?? 0), 0);
  const price = PRICES[model];
  const cost = price ? (tokensIn * price.input + tokensOut * price.output) / 1e6 : null;
  const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
  const count = (pred: (c: (typeof criteria)[number]) => boolean) => criteria.filter(pred).length;
  const byCode = new Map<string, number>();
  for (const w of warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;

  return [
    `# Spec Engine eval: ${model} · ${PROMPT_VERSION}`,
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Requests | ${results.length} |`,
    `| Drafted | ${drafted.length} (${pct(drafted.length, results.length)}) |`,
    `| Valid specs | ${pct(drafted.filter((r) => r.valid_spec).length, results.length)} |`,
    `| Vertical matches expected | ${pct(
      drafted.filter((r) => r.draft?.output.vertical === r.expected_vertical).length,
      drafted.length,
    )} |`,
    `| Criteria (avg per request) | ${criteria.length} (${(criteria.length / Math.max(1, drafted.length)).toFixed(1)}) |`,
    `| Criteria with a lint warning | ${pct(perCriterionFlagged, criteria.length)} |`,
    `| Check types: deterministic / domain / judge | ${count((c) => c.check === "deterministic")} / ${count((c) => c.check === "domain")} / ${count((c) => c.check === "judge")} |`,
    `| Critical criteria | ${pct(
      count((c) => c.critical),
      criteria.length,
    )} |`,
    `| Requests with open questions | ${pct(
      drafted.filter((r) => (r.draft?.output.open_questions.length ?? 0) > 0).length,
      drafted.length,
    )} |`,
    `| Tokens in / out | ${tokensIn} / ${tokensOut} |`,
    `| Est. cost | ${cost === null ? "n/a" : `$${cost.toFixed(2)}`} |`,
    `| p95 latency | ${(p95 / 1000).toFixed(1)} s |`,
    "",
    "Lint warnings by code:",
    ...[...byCode.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${c}: ${n}`),
    "",
    ...(results.some((r) => !r.ok || !r.valid_spec)
      ? [
          "Failures:",
          ...results
            .filter((r) => !r.ok || !r.valid_spec)
            .map((r) => `- ${r.id}: ${r.error ?? r.invalid_reason}`),
          "",
        ]
      : []),
    "Human rating: fill `testable` (y/n) in review.csv, then run `npm run eval:spec:score -- <path>`.",
    "",
  ].join("\n");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

await main();
