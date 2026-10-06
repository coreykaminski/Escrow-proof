import type { Outcome, Spec } from "@proofdesk/core";

export const LANGS = ["en", "es", "fr", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** MQM-style severity: critical/major fail a criterion, minor doesn't. */
export type Severity = "critical" | "major" | "minor";

/**
 * Something a check noticed. `high` confidence findings from deterministic checks are trusted
 * on their own (the critical-error override); `medium` ones are evidence for the judges.
 */
export interface Finding {
  kind:
    | "number_mismatch"
    | "date_mismatch"
    | "omission_suspected"
    | "addition_suspected"
    | "untranslated_segment"
    | "injection_suspected"
    | "empty_deliverable";
  severity: Severity;
  confidence: "high" | "medium";
  message: string;
  /** 0-based paragraph indexes, when the finding is local. */
  source_segment?: number;
  target_segment?: number;
  evidence?: { source?: string; target?: string };
}

export interface TranslationInput {
  spec: Spec;
  /** The source document the buyer provided (plain text, paragraphs split by blank lines). */
  source: string;
  /** The seller's deliverable (plain text). */
  target: string;
  sourceLang?: Lang;
  targetLang?: Lang;
}

export type Verdict = "pass" | "fail" | "uncertain";

/** One opinion about one criterion, from one signal source. */
export interface CriterionSignal {
  criterion_id: string;
  source: "deterministic" | "annotator" | "judge";
  verdict: Verdict;
  /** 0-1, how sure this source is. */
  confidence: number;
  reason: string;
  /** Quotes from the deliverable (and source) supporting the verdict. */
  evidence?: { source?: string; target?: string }[];
}

export interface CriterionResult {
  criterion_id: string;
  critical: boolean;
  verdict: Verdict;
  confidence: number;
  signals: CriterionSignal[];
}

export type Decision =
  | { action: "decide"; outcome: Outcome; confidence: number; reason: string }
  | { action: "escalate"; confidence: number; reason: string };

export interface VerificationReport {
  engine_version: string;
  languages: { source: Lang; target: Lang };
  findings: Finding[];
  criteria: CriterionResult[];
  decision: Decision;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  latency_ms: number;
}
