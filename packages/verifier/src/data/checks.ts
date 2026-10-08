import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Finding } from "../types.ts";
import { htmlToText, type Transport } from "./fetch.ts";

// ---------------------------------------------------------------------------------------------
// Schema, record count, uniqueness
// ---------------------------------------------------------------------------------------------

export interface SchemaResult {
  errors: { path: string; message: string }[];
  /** minItems failures, reported separately as too few records. */
  tooFew: { required: number; got: number } | null;
  duplicates: { keys: string[]; value: string }[];
}

/**
 * Validates against the buyer's JSON Schema (2020-12, formats checked). CSV values are strings,
 * so they're coerced to the schema's types first. `x-unique-keys: ["field", …]` on an array
 * schema requires those fields to be unique across records.
 */
export function checkSchema(
  data: unknown,
  schema: Record<string, unknown>,
  coerce: boolean,
): SchemaResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: coerce });
  addFormats.default(ajv);
  ajv.addKeyword({ keyword: "x-unique-keys", schemaType: "array" });
  const validate = ajv.compile(schema);
  // Coercion mutates; validate a copy so the original stays as delivered.
  const copy = structuredClone(data);
  validate(copy);
  let tooFew: SchemaResult["tooFew"] = null;
  const errors: SchemaResult["errors"] = [];
  for (const e of validate.errors ?? []) {
    if (e.keyword === "minItems" && e.instancePath === "") {
      tooFew = {
        required: Number((e.params as { limit: number }).limit),
        got: Array.isArray(copy) ? copy.length : 0,
      };
      continue;
    }
    errors.push({ path: e.instancePath || "/", message: e.message ?? e.keyword });
  }
  const duplicates: SchemaResult["duplicates"] = [];
  const keys = schema["x-unique-keys"];
  if (Array.isArray(keys) && Array.isArray(data)) {
    const seen = new Set<string>();
    for (const rec of data) {
      if (!rec || typeof rec !== "object") continue;
      const value = JSON.stringify(keys.map((k) => (rec as Record<string, unknown>)[String(k)]));
      if (seen.has(value)) duplicates.push({ keys: keys.map(String), value });
      seen.add(value);
    }
  }
  return { errors, tooFew, duplicates };
}

// ---------------------------------------------------------------------------------------------
// Citations and quotes (research deliverables)
// ---------------------------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/g;

/** Cited URLs: inline links, bare URLs and footnote definitions ("[1]: https://…"). */
export function extractCitations(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

/**
 * Direct quotes attributed to a source: a quoted span of 20+ characters in a paragraph that
 * cites exactly one URL (inline, or via a [n] footnote).
 */
export function extractQuotes(text: string): { quote: string; url: string }[] {
  const footnotes = new Map<string, string>();
  for (const m of text.matchAll(/^\s*\[(\w+)\]:\s*(https?:\/\/\S+)/gm)) {
    footnotes.set(m[1] as string, (m[2] as string).replace(/[.,;]+$/, ""));
  }
  const out: { quote: string; url: string }[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    if (/^\s*\[\w+\]:\s*https?:/.test(para)) continue;
    const urls = new Set(para.match(URL_RE) ?? []);
    for (const ref of para.matchAll(/\[(\w+)\](?!\()/g)) {
      const u = footnotes.get(ref[1] as string);
      if (u) urls.add(u);
    }
    if (urls.size !== 1) continue;
    const url = [...urls][0] as string;
    for (const q of para.matchAll(/[“"]([^”"]{20,600})[”"]/g)) {
      out.push({ quote: (q[1] as string).trim(), url });
    }
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}'"]+/gu, " ")
    .trim();

export interface CitationCheck {
  citations: { url: string; status: "ok" | "unreachable" | "blocked"; http_status?: number }[];
  quotes: { quote: string; url: string; found: boolean }[];
  findings: Finding[];
}

/**
 * Fetches each cited URL (buyer-provided `sources/…` inputs are used without the network) and
 * checks that direct quotes appear in the cited page. A page that loaded but is too thin to
 * judge (e.g. a script-rendered app) only yields a medium-confidence finding.
 */
export async function checkCitations(
  text: string,
  transport: Transport,
  localSources: Map<string, string>,
): Promise<CitationCheck> {
  const findings: Finding[] = [];
  const urls = extractCitations(text);
  const pages = new Map<
    string,
    { status: "ok" | "unreachable" | "blocked"; http_status?: number; text?: string }
  >();
  await Promise.all(
    urls.slice(0, 40).map(async (url) => {
      const local = localSources.get(url);
      if (local !== undefined) {
        pages.set(url, { status: "ok", text: local });
        return;
      }
      const r = await transport(url);
      const body = r.body ?? "";
      pages.set(url, {
        status: r.status,
        ...(r.http_status ? { http_status: r.http_status } : {}),
        ...(r.status === "ok"
          ? {
              text:
                /html/i.test(r.content_type ?? "") || /<html|<body|<p[ >]/i.test(body)
                  ? htmlToText(body)
                  : body,
            }
          : {}),
      });
    }),
  );
  const citations = urls.slice(0, 40).map((url) => {
    const p = pages.get(url);
    return {
      url,
      status: p?.status ?? "unreachable",
      ...(p?.http_status ? { http_status: p.http_status } : {}),
    };
  });
  for (const c of citations) {
    if (c.status === "ok") continue;
    findings.push({
      kind: "citation_unreachable",
      severity: "critical",
      confidence: "high",
      message:
        c.status === "blocked"
          ? `Cited URL ${c.url} points at a private or disallowed address.`
          : `Cited URL ${c.url} didn't load${c.http_status ? ` (HTTP ${c.http_status})` : ""}.`,
      evidence: { target: c.url },
    });
  }

  const quotes = extractQuotes(text).map((q) => {
    const page = pages.get(q.url);
    const found = page?.text !== undefined && norm(page.text).includes(norm(q.quote));
    if (page?.status === "ok" && page.text !== undefined && !found) {
      const thin = page.text.length < 500;
      findings.push({
        kind: "quote_not_in_source",
        severity: "critical",
        confidence: thin ? "medium" : "high",
        message: `The quote "${q.quote.slice(0, 120)}" isn't in the cited source ${q.url}.`,
        evidence: { target: q.quote },
      });
    }
    return { ...q, found };
  });
  return { citations, quotes, findings };
}
