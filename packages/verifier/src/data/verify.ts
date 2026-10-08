import type { Spec } from "@proofdesk/core";
import type { StructuredCaller } from "../llm/claude.ts";
import { combine, decide } from "../policy.ts";
import { INJECTION_PATTERNS, normalizeForScan } from "../translation/text.ts";
import type { CriterionSignal, DataReport, Finding } from "../types.ts";
import { type CitationCheck, checkCitations, checkSchema, type SchemaResult } from "./checks.ts";
import { safeTransport, type Transport } from "./fetch.ts";
import { type DataFile, formatOf, parseData, stringsIn } from "./parse.ts";
import { DATA_REVIEW_PROMPT_VERSION, judgeData } from "./review.ts";

export const DATA_ENGINE_VERSION = `data-v1/${DATA_REVIEW_PROMPT_VERSION}`;

type Criterion = Spec["criteria"][number];

export interface DataInput {
  spec: Spec;
  /**
   * The buyer's files: `schema.json` (JSON Schema for the deliverable) and optional
   * `sources/…` snapshots whose first line is `Source: <url>` (used instead of fetching).
   */
  inputs: DataFile[];
  deliverable: DataFile[];
}

const ROUTES = {
  schema: /\b(schema|fields?|columns?|types?|required|valid\w*|well-formed|formats?)\b/i,
  count: /\b(at least|minimum|or more|records?|rows?|entries|items)\b/i,
  unique: /\b(unique|duplicates?|distinct)\b/i,
  citations: /\b(cit\w*|sources?|links?|references?|urls?)\b/i,
  quotes: /\b(quot\w*|verbatim|attribut\w*)\b/i,
} as const;
type Route = keyof typeof ROUTES;

/** Criterion ids that name a check outright. */
const ID_HINTS: Record<Route, RegExp> = {
  schema: /schema|valid|format|fields|columns|types/,
  count: /count|minimum|at-least|number-of|enough/,
  unique: /unique|duplicate|distinct/,
  citations: /cit|source|link|reference/,
  quotes: /quote|verbatim/,
};

/** The criterion a check reports to: one whose id names it, else one whose text is about it. */
function routeTo(route: Route, criteria: Criterion[]): Criterion | undefined {
  const namesOther = (c: Criterion) =>
    (Object.keys(ID_HINTS) as Route[]).some((r) => r !== route && ID_HINTS[r].test(c.id));
  return (
    criteria.find((c) => ID_HINTS[route].test(c.id)) ??
    criteria.find(
      (c) => !namesOther(c) && ROUTES[route].test(`${c.description} ${c.verification ?? ""}`),
    )
  );
}

/** "at least 25 …" in a criterion's text. */
function atLeast(c: Criterion | undefined): number | null {
  const m = c && /\bat least (\d[\d,]*)/i.exec(`${c.description} ${c.verification ?? ""}`);
  return m ? Number((m[1] as string).replace(/,/g, "")) : null;
}

const FINDING_ROUTES: Partial<Record<Finding["kind"], Route[]>> = {
  parse_error: ["schema"],
  empty_deliverable: ["count", "schema"],
  schema_violation: ["schema"],
  too_few_records: ["count", "schema"],
  duplicate_records: ["unique", "schema"],
  citation_unreachable: ["citations"],
  quote_not_in_source: ["quotes", "citations"],
};

/**
 * Structured data and research verification:
 * 1. parse (JSON, JSONL, CSV, or a markdown report);
 * 2. validate against the buyer's JSON Schema, with record counts and `x-unique-keys`;
 * 3. for reports: every cited URL must load (through the SSRF-safe fetcher) and every direct
 *    quote must appear in its cited source;
 * 4. what that can't settle goes to the model judge (with source excerpts); without a model it
 *    stays uncertain, so a human decides;
 * 5. the shared decision policy.
 * Deterministic checks can fail any criterion, but only pass criteria whose check is
 * "deterministic": a clean schema doesn't prove a "domain" criterion like accuracy.
 */
export async function verifyData(
  input: DataInput,
  deps: { transport?: Transport; caller?: StructuredCaller; now?: () => number } = {},
): Promise<DataReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const criteria = input.spec.criteria;
  const findings: Finding[] = [];
  const passes = new Map<Route, string>();

  const schemaFile = input.inputs.find(
    (f) => /(^|\/)schema\.json$/i.test(f.name) || /schema\+json/i.test(f.media_type),
  );
  const localSources = new Map<string, string>();
  for (const f of input.inputs.filter((f) => f.name.startsWith("sources/"))) {
    const m = /^Source:\s*(https?:\/\/\S+)\s*\n/i.exec(f.content);
    if (m) localSources.set(m[1] as string, f.content.slice(m[0].length));
  }
  const main = input.deliverable.find((f) => f !== schemaFile && f.content.trim().length > 0);
  const format = main ? formatOf(main) : "json";

  let data: unknown = null;
  let records: number | null = null;
  let schema: SchemaResult | null = null;
  let cites: CitationCheck = { citations: [], quotes: [], findings: [] };

  if (!main) {
    findings.push({
      kind: "empty_deliverable",
      severity: "critical",
      confidence: "high",
      message: "The delivery is empty.",
    });
  } else {
    try {
      data = parseData(main);
    } catch (err) {
      findings.push({
        kind: "parse_error",
        severity: "critical",
        confidence: "high",
        message: `${main.name} can't be parsed as ${format.toUpperCase()}: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  if (data !== null && format !== "markdown") {
    records = Array.isArray(data) ? data.length : null;
    if (schemaFile) {
      let parsedSchema: Record<string, unknown>;
      try {
        parsedSchema = JSON.parse(schemaFile.content);
      } catch {
        throw new Error("the buyer's schema.json isn't valid JSON");
      }
      schema = checkSchema(data, parsedSchema, format === "csv");
      if (schema.errors.length > 0) {
        findings.push({
          kind: "schema_violation",
          severity: "critical",
          confidence: "high",
          message: `${schema.errors.length} schema error(s): ${schema.errors
            .slice(0, 5)
            .map((e) => `${e.path} ${e.message}`)
            .join("; ")}`,
        });
      } else passes.set("schema", "Every record matches the schema.");
      if (schema.duplicates.length > 0) {
        findings.push({
          kind: "duplicate_records",
          severity: "critical",
          confidence: "high",
          message: `${schema.duplicates.length} duplicate record(s) on ${schema.duplicates[0]?.keys.join(", ")}: ${schema.duplicates
            .slice(0, 3)
            .map((d) => d.value)
            .join("; ")}`,
        });
      } else if (Array.isArray(parsedSchema["x-unique-keys"])) {
        passes.set("unique", "No duplicate records.");
      }
      if (schema.tooFew) {
        findings.push({
          kind: "too_few_records",
          severity: "critical",
          confidence: "high",
          message: `${schema.tooFew.got} records delivered; at least ${schema.tooFew.required} required.`,
        });
      }
    }
    const min = atLeast(routeTo("count", criteria));
    if (records !== null && min !== null && records < min && !schema?.tooFew) {
      findings.push({
        kind: "too_few_records",
        severity: "critical",
        confidence: "high",
        message: `${records} records delivered; at least ${min} required.`,
      });
    }
    if (records !== null && !findings.some((f) => f.kind === "too_few_records")) {
      passes.set("count", `${records} records delivered.`);
    }
  }

  const text = main?.content ?? "";
  if (main && (format === "markdown" || routeTo("citations", criteria))) {
    cites = await checkCitations(text, deps.transport ?? safeTransport, localSources);
    findings.push(...cites.findings);
    const minCites = atLeast(routeTo("citations", criteria));
    const okCites = cites.citations.filter((c) => c.status === "ok").length;
    if (minCites !== null && okCites < minCites) {
      findings.push({
        kind: "citation_unreachable",
        severity: "critical",
        confidence: "high",
        message: `${okCites} working source(s) cited; at least ${minCites} required.`,
      });
    } else if (cites.citations.length > 0 && cites.citations.every((c) => c.status === "ok")) {
      passes.set("citations", `All ${cites.citations.length} cited sources load.`);
    }
    if (cites.quotes.length > 0 && cites.quotes.every((q) => q.found)) {
      passes.set("quotes", `All ${cites.quotes.length} direct quotes appear in their sources.`);
    }
  }

  const scanned = normalizeForScan(
    data !== null && format !== "markdown" ? stringsIn(data).join("\n") : text,
  );
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(scanned);
    if (m) {
      findings.push({
        kind: "injection_suspected",
        severity: "major",
        confidence: "medium",
        message: `The deliverable contains text addressed to the verifier: "${m[0]}"`,
        evidence: { target: m[0] },
      });
      break;
    }
  }

  // --- Signals ---
  const signals: CriterionSignal[] = [];
  const overrides: Finding[] = [];
  for (const f of findings) {
    if (f.kind === "injection_suspected") continue;
    const c = (FINDING_ROUTES[f.kind] ?? []).map((r) => routeTo(r, criteria)).find(Boolean);
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
  const failed = new Set(signals.map((s) => s.criterion_id));
  for (const [route, reason] of passes) {
    const c = routeTo(route, criteria);
    if (c?.check !== "deterministic" || failed.has(c.id)) continue;
    if (signals.some((s) => s.criterion_id === c.id)) continue;
    signals.push({
      criterion_id: c.id,
      source: "deterministic",
      verdict: "pass",
      confidence: 0.95,
      reason,
    });
  }

  // --- Model judge for the rest ---
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const settled = new Set(signals.map((s) => s.criterion_id));
  const forJudge = criteria.filter((c) => !settled.has(c.id) || c.check === "judge");
  const hardFail =
    overrides.length > 0 ||
    signals.some(
      (s) => s.verdict === "fail" && criteria.find((c) => c.id === s.criterion_id)?.critical,
    );
  let modelInjection = false;
  if (deps.caller && !hardFail && forJudge.length > 0 && main) {
    const sources: { url: string; text: string }[] = [];
    for (const c of cites.citations.filter((c) => c.status === "ok").slice(0, 6)) {
      const local = localSources.get(c.url);
      const r = local !== undefined ? null : await (deps.transport ?? safeTransport)(c.url);
      sources.push({ url: c.url, text: local ?? r?.body ?? "" });
    }
    const checks = [
      ...[...passes.values()].map((p) => `PASS ${p}`),
      ...findings.map((f) => `${f.severity.toUpperCase()} ${f.message}`),
    ].join("\n");
    const { output: j, usage: u } = await judgeData(deps.caller, {
      spec: input.spec,
      criteria: forJudge,
      deliverable: text,
      checks: checks || "(none)",
      sources,
    });
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.cost_usd += u.cost_usd;
    modelInjection = j.injection_detected;
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    const inText = (q: string) => q.trim().length > 0 && squash(text).includes(squash(q));
    const judged = new Set(forJudge.map((c) => c.id));
    const CONF = { low: 0.5, medium: 0.75, high: 0.95 } as const;
    for (const r of j.criteria) {
      if (!judged.has(r.criterion_id)) continue;
      let confidence: number = CONF[r.confidence];
      let reason = r.reason;
      if (r.verdict === "fail" && !r.evidence.some(inText)) {
        confidence = Math.min(confidence, 0.5);
        reason += " (evidence not found in the deliverable)";
      }
      signals.push({
        criterion_id: r.criterion_id,
        source: "judge",
        verdict: r.verdict,
        confidence,
        reason,
        evidence: r.evidence.map((target) => ({ target })),
      });
    }
  }

  const results = combine(criteria, signals);
  const injection = findings.some((f) => f.kind === "injection_suspected") || modelInjection;
  const decision = decide(results, { injection, overrides });
  return {
    engine_version: DATA_ENGINE_VERSION,
    vertical: "data",
    findings,
    criteria: results,
    decision,
    data: {
      format,
      records,
      schema_errors: (schema?.errors ?? []).slice(0, 50),
      citations: cites.citations,
      quotes: cites.quotes,
    },
    usage: { ...usage, cost_usd: Math.round(usage.cost_usd * 1e6) / 1e6 },
    latency_ms: now() - started,
  };
}
