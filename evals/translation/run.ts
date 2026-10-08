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
import { type EvalRow, summarize } from "../shared/metrics.ts";
import { type GoldenItem, mulberry32, shuffle } from "./golden.ts";
import { mapLimit } from "./llm.ts";

const here = dirname(fileURLToPath(import.meta.url));

export { TARGETS } from "../shared/metrics.ts";

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

interface Row extends EvalRow {
  report?: VerificationReport;
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

  const { summary, pass } = summarize("Translation verifier eval", rows);
  const out = join(here, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "results.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  writeFileSync(join(out, "summary.md"), summary);
  console.log(`\n${summary}\nWrote ${out}`);
  process.exitCode = pass ? 0 : 1;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) await main();
