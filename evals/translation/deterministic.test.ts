/**
 * CI gate for the deterministic layer on the golden set (free, no model calls):
 * - no high-confidence finding on any item whose right answer is "release" (no false refunds
 *   from the critical-error override);
 * - every error type the deterministic layer is responsible for is caught at high confidence.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeterministic } from "@proofdesk/verifier";
import { describe, expect, it } from "vitest";
import type { ErrorType, GoldenItem } from "./golden.ts";

const here = dirname(fileURLToPath(import.meta.url));
const items: GoldenItem[] = readFileSync(join(here, "golden.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const run = (i: GoldenItem) =>
  runDeterministic({
    source: i.source,
    target: i.target,
    sourceLang: i.pair.source,
    targetLang: i.pair.target,
  });
const highFindings = (i: GoldenItem) => run(i).findings.filter((f) => f.confidence === "high");
const primary = (i: GoldenItem): ErrorType | "clean" => i.expected.errors[0]?.type ?? "clean";

describe("deterministic layer on the golden set", () => {
  it("has the full golden set", () => {
    expect(items.length).toBe(300);
  });

  it("never raises a high-confidence finding on an item that should be released", () => {
    const falseAlarms = items
      .filter((i) => i.expected.outcome === "release")
      .map((i) => ({ id: i.id, findings: highFindings(i).map((f) => f.message) }))
      .filter((x) => x.findings.length > 0);
    expect(falseAlarms).toEqual([]);
  });

  it.each([
    ["number", "number_mismatch"],
    ["date", "date_mismatch"],
    ["omission_paragraph", "omission_suspected"],
    ["truncation", "omission_suspected"],
    ["untranslated", "untranslated_segment"],
  ] as const)("catches every %s error at high confidence", (type, kind) => {
    const missed = items
      .filter((i) => primary(i) === type)
      .filter((i) => !highFindings(i).some((f) => f.kind === kind))
      .map((i) => i.id);
    expect(missed).toEqual([]);
  });

  it("flags every injection that uses an instruction phrase, and every masked number", () => {
    const missed = items
      .filter((i) => primary(i) === "injection")
      .filter((i) => {
        const kinds = highFindings(i).map((f) => f.kind);
        const phrase = !i.target.includes("Translator's QA record");
        const masked = i.expected.errors.some((e) => e.type === "number");
        return (
          (phrase && !kinds.includes("injection_suspected")) ||
          (masked && !kinds.includes("number_mismatch"))
        );
      })
      .map((i) => i.id);
    expect(missed).toEqual([]);
  });
});
