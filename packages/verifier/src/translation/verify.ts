import type { StructuredCaller } from "../llm/claude.ts";
import type { CriterionSignal, TranslationInput, VerificationReport } from "../types.ts";
import { runDeterministic } from "./deterministic.ts";
import {
  annotatorSignals,
  combine,
  decide,
  deterministicSignals,
  judgeSignals,
} from "./ensemble.ts";
import { annotate, judge, REVIEW_PROMPT_VERSION } from "./review.ts";

export const ENGINE_VERSION = `translation-v1/${REVIEW_PROMPT_VERSION}`;

export class VerificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationInputError";
  }
}

/**
 * Translation verification, cheapest layer first:
 * 1. deterministic checks; a high-confidence critical finding decides on its own (refund) and
 *    the model layers are skipped;
 * 2. otherwise an MQM annotator (Opus) and a per-criterion judge (Sonnet) run in parallel;
 * 3. their signals are combined per criterion and the decision policy picks release / refund /
 *    escalate.
 */
export async function verifyTranslation(
  input: TranslationInput,
  deps: { caller: StructuredCaller; rand?: () => number; now?: () => number },
): Promise<VerificationReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const det = runDeterministic(input);
  if (!det.languages.source) {
    throw new VerificationInputError("couldn't identify the source document's language");
  }
  const criteria = input.spec.criteria;
  const injection = det.findings.some((f) => f.kind === "injection_suspected");
  const { signals: detSignals, overrides } = deterministicSignals(det.findings, criteria);
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  const hardFail =
    overrides.length > 0 ||
    detSignals.some(
      (s) => s.verdict === "fail" && criteria.find((c) => c.id === s.criterion_id)?.critical,
    );
  const signals: CriterionSignal[] = [...detSignals];
  let annotatorInjection = false;

  if (!hardFail) {
    const target = det.languages.target;
    if (!target) {
      throw new VerificationInputError("couldn't identify the deliverable's language");
    }
    const ctx = {
      spec: input.spec,
      src: det.sourceParagraphs,
      tgt: det.targetParagraphs,
      langs: { source: det.languages.source, target },
      ...(deps.rand ? { rand: deps.rand } : {}),
    };
    const [a, j] = await Promise.all([annotate(deps.caller, ctx), judge(deps.caller, ctx)]);
    for (const u of [a.usage, j.usage]) {
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.cost_usd += u.cost_usd;
    }
    annotatorInjection = a.output.injection_detected;
    signals.push(
      ...annotatorSignals(a.output, criteria, input.source, input.target),
      ...judgeSignals(j.output, criteria, input.source, input.target),
    );
  }

  const results = combine(criteria, signals);
  const decision = decide(results, { injection: injection || annotatorInjection, overrides });
  return {
    engine_version: ENGINE_VERSION,
    languages: { source: det.languages.source, target: det.languages.target },
    findings: det.findings,
    criteria: results,
    decision,
    usage: { ...usage, cost_usd: Math.round(usage.cost_usd * 1e6) / 1e6 },
    latency_ms: now() - started,
  };
}
