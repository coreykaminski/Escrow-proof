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
  kind: // translation
    | "number_mismatch"
    | "date_mismatch"
    | "omission_suspected"
    | "addition_suspected"
    | "untranslated_segment"
    | "injection_suspected"
    | "empty_deliverable"
    // code
    | "tests_failed"
    | "tests_not_run"
    | "timeout"
    | "sandbox_violation"
    | "tests_tampered"
    | "path_not_allowed"
    | "missing_file"
    // data
    | "parse_error"
    | "schema_violation"
    | "too_few_records"
    | "duplicate_records"
    | "citation_unreachable"
    | "quote_not_in_source";
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

/** What every vertical's report has; the API, ledger and dashboard only rely on this. */
export interface BaseReport {
  engine_version: string;
  findings: Finding[];
  criteria: CriterionResult[];
  decision: Decision;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  latency_ms: number;
}

/** Translation report. */
export interface VerificationReport extends BaseReport {
  /** target is null when the deliverable isn't in any identifiable target language. */
  languages: { source: Lang; target: Lang | null };
}

export interface TestCaseResult {
  name: string;
  /** The criterion the test is tagged with ("[id] …" or "id: …"), if any. */
  criterion_id: string | null;
  status: "pass" | "fail" | "skip";
  message?: string;
}

/** Code report: the sandboxed run of the buyer's acceptance tests. */
export interface CodeReport extends BaseReport {
  vertical: "code";
  tests: {
    runtime: string;
    sandbox: string;
    exit_code: number | null;
    timed_out: boolean;
    duration_ms: number;
    passed: number;
    failed: number;
    cases: TestCaseResult[];
    /** Tail of the runner's output, for reviewers. */
    log: string;
  };
}

/** Data/research report: parsing, schema validation and citation checks. */
export interface DataReport extends BaseReport {
  vertical: "data";
  data: {
    format: "json" | "jsonl" | "csv" | "markdown";
    records: number | null;
    schema_errors: { path: string; message: string }[];
    citations: { url: string; status: "ok" | "unreachable" | "blocked"; http_status?: number }[];
    quotes: { quote: string; url: string; found: boolean }[];
  };
}

export type AnyReport = VerificationReport | CodeReport | DataReport;
