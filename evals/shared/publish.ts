/**
 * "Verifier accuracy v0": the latest labelled test-set run of each verifier, as published on
 * /accuracy. Built only from committed runs (evals/<suite>/runs/<ts>/{meta.json,results.jsonl}),
 * so every published number traces to an exact test set (by hash) and set of layers. For each
 * suite it publishes the latest run without model layers and the latest with them, if any.
 *
 *   npm run evals:publish     # rewrites apps/api/src/data/golden-results.json
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvalRow, metricsOf, type RunMeta, TARGETS } from "./metrics.ts";

const evalsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLISHED_PATH = join(evalsDir, "..", "apps/api/src/data/golden-results.json");

const SUITES = [
  {
    suite: "translation",
    name: "Translation",
    pending:
      "The deterministic layer (numbers, dates, amounts, names, omitted clauses) is gated in CI on all 300 test items. The full verifier, with its model layers, hasn't been measured yet.",
  },
  {
    suite: "code",
    name: "Code",
    pending:
      "Covers the layers that decide every code job: the buyer's tests in the sandbox and the static scan. The optional model-judge criterion hasn't been measured yet.",
  },
  {
    suite: "data",
    name: "Data and research",
    pending:
      "Covers the layers that decide every data job: schema, count and uniqueness checks, fetched citations and verbatim quotes. The optional model-judge criterion hasn't been measured yet.",
  },
] as const;

function runs(suite: string) {
  const dir = join(evalsDir, suite, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "meta.json")))
    .sort()
    .map((id) => {
      const meta = JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8")) as RunMeta;
      const rows = readFileSync(join(dir, id, "results.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EvalRow);
      return { id, meta, rows };
    });
}

function runJson(r: ReturnType<typeof runs>[number]) {
  const m = metricsOf(r.rows);
  return {
    run_id: r.id,
    title: r.meta.title,
    layers: r.meta.layers,
    model_layers: r.meta.model_layers,
    golden_sha256: r.meta.golden_sha256,
    golden_items: r.meta.golden_items,
    items_run: r.meta.items_run,
    run_at: r.meta.created_at,
    metrics: m.metrics,
    escalation_all: m.escalation_all,
    p95_latency_s: Math.round(m.p95_latency_s * 10) / 10,
    errors: m.errors,
    pass: m.pass,
  };
}

export function buildPublished() {
  return {
    object: "golden_set_accuracy",
    version: "v0",
    targets: TARGETS,
    suites: SUITES.map((s) => {
      const all = runs(s.suite);
      const latest = (model: boolean) => all.filter((r) => r.meta.model_layers === model).at(-1);
      const picked = [latest(false), latest(true)].filter((r) => r !== undefined).map(runJson);
      return {
        suite: s.suite,
        name: s.name,
        status: picked.length ? "measured" : "pending",
        model_layers_measured: picked.some((r) => r.model_layers),
        note: picked.some((r) => r.model_layers) ? null : s.pending,
        runs: picked,
      };
    }),
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(PUBLISHED_PATH, `${JSON.stringify(buildPublished(), null, 2)}\n`);
  console.log(`wrote ${PUBLISHED_PATH}`);
}
