import type { Spec } from "@proofdesk/core";
import type { CriterionResult, CriterionSignal, Decision, Finding, Verdict } from "../types.ts";
import { type Annotation, type Judgment, quoteFound } from "./review.ts";

type Criterion = Spec["criteria"][number];

/**
 * Which criterion a finding or error category is about, by keywords in the criterion text.
 * Works for any drafted spec, not just the golden one.
 */
const ROUTES: Record<string, RegExp> = {
  values: /\b(numbers?|amounts?|values?|dates?|figures?|percent\w*|prices?|sums?|durations?)\b/i,
  omission:
    /\b(omit\w*|omission|complete\w*|truncat\w*|missing|every (source )?(sentence|clause|paragraph|segment))\b/i,
  addition: /\b(add\w*|addition|extra|nothing that is not in the source|not in the source)\b/i,
  untranslated: /\b(untranslated|language|written in|entirely in)\b/i,
  names: /\b(names?|part(y|ies)|persons?|compan(y|ies))\b/i,
  mistranslation: /\b(meaning|accura\w*|mistranslat\w*|faithful\w*|obligations?|negations?)\b/i,
  terminology: /\b(term\w*|glossary)\b/i,
  style: /\b(register|tone|style|fluen\w*|formal\w*)\b/i,
};

const FINDING_ROUTE: Record<Finding["kind"], string> = {
  number_mismatch: "values",
  date_mismatch: "values",
  omission_suspected: "omission",
  addition_suspected: "addition",
  untranslated_segment: "untranslated",
  injection_suspected: "addition",
  empty_deliverable: "omission",
};

const CATEGORY_ROUTE: Record<Annotation["errors"][number]["category"], string> = {
  omission: "omission",
  addition: "addition",
  mistranslation: "mistranslation",
  terminology: "terminology",
  names: "names",
  values: "values",
  untranslated: "untranslated",
  fluency: "style",
  style: "style",
};

export function routeTo(route: string, criteria: Criterion[]): Criterion | undefined {
  const re = ROUTES[route];
  if (!re) return undefined;
  // Prefer the criterion whose id names the route, then the first whose text matches.
  return (
    criteria.find((c) => re.test(c.id.replace(/-/g, " "))) ??
    criteria.find((c) => re.test(`${c.description} ${c.verification ?? ""}`))
  );
}

/**
 * High-confidence deterministic findings fail their criterion outright. A critical one that no
 * criterion covers is returned as an override: a translation that is missing text or changes a
 * value fails whether or not the spec spelled that out.
 */
export function deterministicSignals(
  findings: Finding[],
  criteria: Criterion[],
): { signals: CriterionSignal[]; overrides: Finding[] } {
  const signals: CriterionSignal[] = [];
  const overrides: Finding[] = [];
  for (const f of findings) {
    if (f.kind === "injection_suspected") continue; // handled by the decision policy
    const c = routeTo(FINDING_ROUTE[f.kind], criteria);
    if (!c) {
      if (f.confidence === "high" && f.severity === "critical") overrides.push(f);
      continue;
    }
    signals.push({
      criterion_id: c.id,
      source: "deterministic",
      verdict: f.confidence === "high" ? "fail" : "uncertain",
      confidence: f.confidence === "high" ? 0.99 : 0.5,
      reason: f.message,
      ...(f.evidence ? { evidence: [f.evidence] } : {}),
    });
  }
  return { signals, overrides };
}

export function annotatorSignals(
  annotation: Annotation,
  criteria: Criterion[],
  src: string,
  tgt: string,
): CriterionSignal[] {
  const ids = new Set(criteria.map((c) => c.id));
  const byCriterion = new Map<string, Annotation["errors"]>();
  for (const e of annotation.errors) {
    if (e.severity === "minor") continue;
    let targets = e.criterion_ids.filter((id) => ids.has(id));
    if (targets.length === 0) {
      const routed = routeTo(CATEGORY_ROUTE[e.category], criteria);
      targets = routed ? [routed.id] : [];
    }
    for (const id of targets) byCriterion.set(id, [...(byCriterion.get(id) ?? []), e]);
  }
  return criteria.map((c) => {
    const errors = byCriterion.get(c.id) ?? [];
    if (errors.length === 0) {
      return {
        criterion_id: c.id,
        source: "annotator",
        verdict: "pass",
        confidence: 0.8,
        reason: "no errors annotated",
      };
    }
    // Evidence must be real: quotes the model gives have to exist in the texts.
    const verified = errors.filter(
      (e) => quoteFound(e.source_quote, src) && quoteFound(e.target_quote, tgt),
    );
    const worst = (verified.length ? verified : errors).some((e) => e.severity === "critical");
    return {
      criterion_id: c.id,
      source: "annotator",
      verdict: "fail",
      confidence: verified.length === 0 ? 0.5 : worst ? 0.9 : 0.8,
      reason: errors.map((e) => `${e.severity} ${e.category}: ${e.explanation}`).join(" | "),
      evidence: errors.map((e) => ({ source: e.source_quote, target: e.target_quote })),
    };
  });
}

const CONFIDENCE = { low: 0.5, medium: 0.75, high: 0.95 } as const;

export function judgeSignals(
  judgment: Judgment,
  criteria: Criterion[],
  src: string,
  tgt: string,
): CriterionSignal[] {
  const ids = new Set(criteria.map((c) => c.id));
  return judgment.criteria
    .filter((j) => ids.has(j.criterion_id))
    .map((j) => {
      let confidence: number = CONFIDENCE[j.confidence];
      let reason = j.reason;
      if (j.verdict === "fail") {
        const real = j.evidence.filter(
          (e) => quoteFound(e.source_quote, src) && quoteFound(e.target_quote, tgt),
        );
        if (j.evidence.length === 0 || real.length === 0) {
          confidence = Math.min(confidence, 0.5);
          reason += " (evidence not found in the texts)";
        }
      }
      return {
        criterion_id: j.criterion_id,
        source: "judge" as const,
        verdict: j.verdict,
        confidence,
        reason,
        evidence: j.evidence.map((e) => ({ source: e.source_quote, target: e.target_quote })),
      };
    });
}

/**
 * Per criterion: a high-confidence deterministic failure wins. Otherwise the annotator and judge
 * must agree to produce a confident verdict; disagreement or weak evidence is "uncertain".
 */
export function combine(criteria: Criterion[], signals: CriterionSignal[]): CriterionResult[] {
  return criteria.map((c) => {
    const mine = signals.filter((s) => s.criterion_id === c.id);
    const result = (verdict: Verdict, confidence: number): CriterionResult => ({
      criterion_id: c.id,
      critical: c.critical,
      verdict,
      confidence: Math.round(confidence * 100) / 100,
      signals: mine,
    });

    const hard = mine.find((s) => s.source === "deterministic" && s.verdict === "fail");
    if (hard) return result("fail", hard.confidence);

    const models = mine.filter((s) => s.source !== "deterministic");
    const fails = models.filter((s) => s.verdict === "fail");
    const passes = models.filter((s) => s.verdict === "pass");

    if (models.length >= 2 && fails.length === models.length) {
      return result("fail", Math.max(...fails.map((s) => s.confidence)));
    }
    if (models.length >= 2 && passes.length === models.length) {
      const softFinding = mine.some((s) => s.source === "deterministic");
      const conf = Math.min(...passes.map((s) => s.confidence));
      return result("pass", softFinding ? Math.min(conf, 0.7) : conf);
    }
    if (models.length === 1) {
      const only = models[0] as CriterionSignal;
      return only.confidence >= 0.75
        ? result(only.verdict, only.confidence * 0.8)
        : result("uncertain", 0.5);
    }
    // Disagreement: a confident, evidenced fail against a weak pass still isn't enough to refund.
    return result("uncertain", 0.5);
  });
}

export function decide(
  results: CriterionResult[],
  flags: { injection: boolean; overrides?: Finding[] },
): Decision {
  if (flags.overrides?.length) {
    return {
      action: "decide",
      outcome: { kind: "refund" },
      confidence: 0.99,
      reason: `Critical problem found by deterministic checks: ${flags.overrides.map((f) => f.message).join(" ")}`,
    };
  }
  const criticalFails = results.filter((r) => r.critical && r.verdict === "fail");
  if (criticalFails.length > 0) {
    return {
      action: "decide",
      outcome: { kind: "refund" },
      confidence: Math.max(...criticalFails.map((r) => r.confidence)),
      reason: `Failed critical criteria: ${criticalFails.map((r) => r.criterion_id).join(", ")}.`,
    };
  }
  if (flags.injection) {
    return {
      action: "escalate",
      confidence: 0.5,
      reason:
        "The deliverable appears to contain text addressed to the verifier; a human must review it.",
    };
  }
  const unsure = results.filter((r) => r.verdict === "uncertain");
  if (unsure.length > 0) {
    return {
      action: "escalate",
      confidence: 0.5,
      reason: `Checks disagree or lack evidence on: ${unsure.map((r) => r.criterion_id).join(", ")}.`,
    };
  }
  const softFails = results.filter((r) => !r.critical && r.verdict === "fail");
  if (softFails.length > 0) {
    return {
      action: "escalate",
      confidence: 0.6,
      reason: `Non-critical criteria failed (${softFails.map((r) => r.criterion_id).join(", ")}); a human decides whether to release in part.`,
    };
  }
  return {
    action: "decide",
    outcome: { kind: "release" },
    confidence: Math.min(...results.map((r) => r.confidence)),
    reason: "All criteria passed.",
  };
}
