/**
 * Data/research verifier eval on evals/data/golden.jsonl. Deterministic checks are free and run
 * by default (offline: research pages come from each item's fixture web, behind the same SSRF
 * guard as production); --judge adds a model-judged accuracy criterion (costs money).
 *
 *   npm run eval:data
 *   npm run eval:data -- --judge
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseSpec } from "@proofdesk/core";
import { ClaudeCaller, guardedTransport, type Transport, verifyData } from "@proofdesk/verifier";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import { classify, type EvalRow, mapLimit, summarize, writeRun } from "../shared/metrics.ts";
import type { DataGoldenItem } from "./build-golden.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function loadGolden(): DataGoldenItem[] {
  return readFileSync(join(here, "golden.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The item's fixture web; unknown hosts behave like a DNS failure. */
export function fixtureTransport(web: DataGoldenItem["web"]): Transport {
  return guardedTransport(async (url) => {
    const p = web[url];
    if (!p) return { status: "unreachable", url, error: "getaddrinfo ENOTFOUND" };
    return {
      status: p.status >= 200 && p.status < 300 ? "ok" : "unreachable",
      http_status: p.status,
      url,
      content_type: "text/html",
      body: p.body,
    };
  });
}

export async function runItem(
  item: DataGoldenItem,
  opts: { judge?: boolean; caller?: ClaudeCaller } = {},
): Promise<EvalRow> {
  const base = {
    id: item.id,
    type: `${item.task.includes("-") ? "research" : "dataset"}:${item.variant}`,
    expected: item.expected,
    adversarial: item.adversarial,
    critical: item.critical,
  };
  try {
    const spec = parseSpec({
      ...item.spec,
      criteria: [
        ...item.spec.criteria,
        ...(opts.judge
          ? [
              {
                id: "accurate",
                description: "The content is accurate and supported by the cited sources",
                check: "judge" as const,
                critical: true,
              },
            ]
          : []),
      ],
    });
    const report = await verifyData(
      { spec, inputs: item.inputs, deliverable: item.deliverable },
      { transport: fixtureTransport(item.web), ...(opts.caller ? { caller: opts.caller } : {}) },
    );
    return {
      ...base,
      got: classify(report),
      reason: report.decision.reason,
      cost_usd: report.usage.cost_usd,
      latency_ms: report.latency_ms,
    };
  } catch (err) {
    return {
      ...base,
      got: "error",
      reason: "",
      cost_usd: 0,
      latency_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  loadEnv();
  const { values } = parseArgs({ options: { judge: { type: "boolean", default: false } } });
  const caller = values.judge ? new ClaudeCaller() : undefined;
  const rows = await mapLimit(loadGolden(), 8, async (item) => {
    const row = await runItem(item, { judge: values.judge, ...(caller ? { caller } : {}) });
    const mark = row.got === "escalate" ? "?" : row.got === row.expected ? "✓" : "✗";
    console.log(`${mark} ${row.id} → ${row.got}${row.error ? ` (${row.error})` : ""}`);
    return row;
  });
  const title = `Data/research verifier eval${values.judge ? " (with model judge)" : " (deterministic)"}`;
  const { summary, pass } = summarize(title, rows);
  writeRun(
    here,
    {
      suite: "data",
      title,
      layers: [
        "schema, count and uniqueness checks",
        "citations fetched and quotes matched",
        ...(values.judge ? ["model judge"] : []),
      ],
      model_layers: values.judge === true,
    },
    rows,
    summary,
  );
  console.log(`\n${summary}`);
  process.exit(pass ? 0 : 1);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) await main();
