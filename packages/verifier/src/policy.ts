import type { Spec } from "@proofdesk/core";
import type { CriterionResult, CriterionSignal, Decision, Finding, Verdict } from "./types.ts";

type Criterion = Spec["criteria"][number];

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
    // A deterministic pass (e.g. the criterion's tests all passed) stands on its own when no
    // model was asked about the criterion.
    const proven = mine.find((s) => s.source === "deterministic" && s.verdict === "pass");
    if (proven && models.length === 0) return result("pass", proven.confidence);
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
  flags: {
    injection: boolean;
    overrides?: Finding[];
    /** Evidence the deliverable games the checks (e.g. special-cases the tests): a human decides. */
    gaming?: string | null;
  },
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
  if (flags.gaming) {
    return {
      action: "escalate",
      confidence: 0.5,
      reason: `The deliverable may be gaming the checks: ${flags.gaming} A human must review it.`,
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
