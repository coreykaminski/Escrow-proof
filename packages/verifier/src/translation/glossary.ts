import { parseCsv } from "../data/parse.ts";
import type { Finding } from "../types.ts";

/**
 * Glossary adherence (MASTER_PLAN §6): the buyer's approved translations of key terms. Checked
 * deterministically: every glossary term that appears in the source must appear in the
 * deliverable as one of its approved translations. Inflected forms are accepted (a few letters
 * of suffix: "contrato" matches "contratos"), and a target may list alternatives separated by
 * "|" ("Licenciante|Licenciante(s)").
 */
export interface GlossaryEntry {
  source: string;
  targets: string[];
}

/** A glossary file: CSV with `source` and `target` columns (extra columns, e.g. notes, ignored). */
export function isGlossaryFile(f: { name: string; mediaType?: string; media_type?: string }) {
  return /(^|[/_.-])glossary[^/]*\.(csv|tsv)$/i.test(f.name);
}

export function parseGlossary(csv: string): GlossaryEntry[] {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  const out: GlossaryEntry[] = [];
  for (const row of rows) {
    const lower = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]),
    );
    const source = (lower.source ?? lower.term ?? "").trim();
    const targets = (lower.target ?? lower.translation ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    if (source && targets.length) out.push({ source, targets });
  }
  return out;
}

const norm = (s: string) => s.normalize("NFKC").toLocaleLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** The term as a whole word or phrase. */
const exact = (term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(norm(term))}(?![\\p{L}\\p{N}])`, "u");
/** The term, allowing up to 3 letters of inflection on its last word. */
const inflected = (term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(norm(term))}\\p{L}{0,3}(?![\\p{L}\\p{N}])`, "u");

export function checkGlossary(
  source: string,
  target: string,
  glossary: GlossaryEntry[],
): Finding[] {
  const src = norm(source);
  const tgt = norm(target);
  const findings: Finding[] = [];
  for (const entry of glossary) {
    if (!exact(entry.source).test(src)) continue;
    if (entry.targets.some((t) => inflected(t).test(tgt))) continue;
    findings.push({
      kind: "glossary_violation",
      severity: "major",
      confidence: "high",
      message: `The source uses "${entry.source}", but the deliverable never uses its approved translation ${entry.targets
        .map((t) => `"${t}"`)
        .join(" or ")}.`,
      evidence: { source: entry.source },
    });
  }
  return findings;
}
