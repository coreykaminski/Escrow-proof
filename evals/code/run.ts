/**
 * Code verifier eval on evals/code/golden.jsonl. The sandboxed test layer is free and runs by
 * default; --judge adds a "general solution" judge criterion and calls Claude (costs money).
 *
 *   npm run eval:code               # free: deterministic + sandbox
 *   npm run eval:code -- --judge    # with the model judge (needs ANTHROPIC_API_KEY)
 *
 * Writes evals/code/runs/<timestamp>/{results.jsonl,summary.md}. Exits 1 if a target is missed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseSpec } from "@proofdesk/core";
import { ClaudeCaller, NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import { classify, type EvalRow, mapLimit, summarize, writeRun } from "../shared/metrics.ts";
import type { CodeGoldenItem } from "./build-golden.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function loadGolden(): CodeGoldenItem[] {
  return readFileSync(join(here, "golden.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export async function runItem(
  item: CodeGoldenItem,
  opts: { judge?: boolean; timeoutMs?: number; caller?: ClaudeCaller } = {},
): Promise<EvalRow> {
  const base = {
    id: item.id,
    type: item.variant,
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
                id: "general-solution",
                description:
                  "Solves the task in general; doesn't special-case the test inputs or phone home",
                check: "judge" as const,
                critical: true,
              },
            ]
          : []),
      ],
    });
    const report = await verifyCode(
      { spec, inputs: item.inputs, deliverable: item.deliverable },
      {
        sandbox: new NodePermissionSandbox(),
        timeoutMs: opts.timeoutMs ?? 5_000,
        ...(opts.caller ? { caller: opts.caller } : {}),
      },
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
  const items = loadGolden();
  const rows = await mapLimit(items, 6, async (item) => {
    const row = await runItem(item, { judge: values.judge, ...(caller ? { caller } : {}) });
    const mark = row.got === "escalate" ? "?" : row.got === row.expected ? "✓" : "✗";
    console.log(`${mark} ${row.id} → ${row.got}`);
    return row;
  });
  const title = `Code verifier eval${values.judge ? " (with model judge)" : " (sandbox + deterministic)"}`;
  const { summary, pass } = summarize(title, rows);
  writeRun(
    here,
    {
      suite: "code",
      title,
      layers: [
        "buyer's tests in the sandbox (signed results)",
        "static scan",
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
