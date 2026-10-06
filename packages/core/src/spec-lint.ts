import type { Spec } from "./spec.ts";

/**
 * Deterministic warnings about criteria a verifier would struggle to decide. Advisory only:
 * a spec with warnings can still be approved, but vague criteria are where disputes come from.
 */
export interface SpecWarning {
  code:
    | "vague_wording"
    | "no_verification"
    | "too_long"
    | "no_critical_criterion"
    | "mostly_judge"
    | "single_criterion";
  message: string;
  criterion_id?: string;
}

/** Words that sound like requirements but don't say what passes. */
const VAGUE_TERMS = [
  "high quality",
  "high-quality",
  "good quality",
  "professional",
  "appropriate",
  "appropriately",
  "properly",
  "proper",
  "reasonable",
  "reasonably",
  "nice",
  "clean",
  "well written",
  "well-written",
  "polished",
  "engaging",
  "compelling",
  "natural-sounding",
  "sounds natural",
  "user-friendly",
  "intuitive",
  "best practices",
  "as needed",
  "if necessary",
  "etc",
  "and so on",
  "satisfactory",
  "acceptable",
  "excellent",
];

/**
 * Signals that a criterion names something observable: a number, a quoted string, a
 * universal ("every", "all", "no"), a bound, or a named standard/tool to check against.
 */
const CONCRETE_ANCHOR =
  /\d|["“”'‘’`]|\b(every|each|all|none|no|zero|exactly|at least|at most|no more than|fewer than|matches?|equals?|contains?|present|absent|listed|named|glossary|schema|test suite|tests? pass|compiles?|lint)\b/i;

const MAX_DESCRIPTION = 400;

/** Fixed phrases that contain a vague word but aren't vague ("proper names"). */
const NOT_VAGUE = /\bproper (names?|nouns?)\b/g;

function vagueTermsIn(text: string): string[] {
  const lower = text.toLowerCase().replace(NOT_VAGUE, "");
  return VAGUE_TERMS.filter((t) => new RegExp(`(^|[^a-z])${t}([^a-z]|$)`).test(lower));
}

export function lintSpec(spec: Pick<Spec, "criteria">): SpecWarning[] {
  const warnings: SpecWarning[] = [];

  for (const c of spec.criteria) {
    const text = `${c.description} ${c.verification ?? ""}`;
    const vague = vagueTermsIn(c.description);
    if (vague.length > 0 && !CONCRETE_ANCHOR.test(text)) {
      warnings.push({
        code: "vague_wording",
        criterion_id: c.id,
        message: `"${vague.join('", "')}" doesn't say what passes. Name something a checker can observe.`,
      });
    }
    if (c.check !== "deterministic" && !c.verification) {
      warnings.push({
        code: "no_verification",
        criterion_id: c.id,
        message: "Say how a checker decides pass/fail (what to compare, count or look for).",
      });
    }
    if (c.description.length > MAX_DESCRIPTION) {
      warnings.push({
        code: "too_long",
        criterion_id: c.id,
        message: `Over ${MAX_DESCRIPTION} characters; it probably bundles several checks. Split it.`,
      });
    }
  }

  if (spec.criteria.length === 1) {
    warnings.push({
      code: "single_criterion",
      message: "Only one criterion. Most jobs need separate checks for completeness and accuracy.",
    });
  }
  if (spec.criteria.length > 0 && !spec.criteria.some((c) => c.critical)) {
    warnings.push({
      code: "no_critical_criterion",
      message: "No criterion is critical, so no single failure forces a refund.",
    });
  }
  const judged = spec.criteria.filter((c) => c.check === "judge").length;
  if (spec.criteria.length >= 2 && judged / spec.criteria.length > 0.5) {
    warnings.push({
      code: "mostly_judge",
      message:
        "Over half the criteria rely on an AI judge. Convert some to deterministic or domain checks.",
    });
  }

  return warnings;
}
