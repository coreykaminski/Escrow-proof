import type { Finding, Lang } from "../types.ts";
import { extract, missingFrom } from "./numbers.ts";
import { detectLang, injectionPhrases, paragraphs, words } from "./text.ts";

export interface DeterministicResult {
  languages: { source: Lang | null; target: Lang | null };
  sourceParagraphs: string[];
  targetParagraphs: string[];
  findings: Finding[];
}

const snippet = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Cheap, deterministic checks that run before any model: values preserved, structure kept,
 * everything translated, no text aimed at the verifier. Runs in milliseconds and in CI.
 */
export function runDeterministic(input: {
  source: string;
  target: string;
  sourceLang?: Lang;
  targetLang?: Lang;
}): DeterministicResult {
  const src = paragraphs(input.source);
  const tgt = paragraphs(input.target);
  const findings: Finding[] = [];

  const sourceLang = input.sourceLang ?? detectLang(input.source);
  const detected = tgt.map((p) => detectLang(p));
  const targetLang = input.targetLang ?? mostCommon(detected.filter((l) => l && l !== sourceLang));
  const languages = { source: sourceLang, target: targetLang };

  if (tgt.length === 0) {
    findings.push({
      kind: "empty_deliverable",
      severity: "critical",
      confidence: "high",
      message: "The deliverable has no text.",
    });
    return { languages, sourceParagraphs: src, targetParagraphs: tgt, findings };
  }

  // Structure: a deliverable with fewer paragraphs than the source has lost content.
  if (tgt.length < src.length) {
    findings.push({
      kind: "omission_suspected",
      severity: "critical",
      confidence: "high",
      message: `The source has ${src.length} paragraphs but the deliverable has ${tgt.length}.`,
    });
  } else if (tgt.length > src.length) {
    findings.push({
      kind: "addition_suspected",
      severity: "major",
      confidence: "medium",
      message: `The deliverable has ${tgt.length} paragraphs but the source has ${src.length}; content may have been added (or paragraphs split).`,
    });
  }

  // Untranslated paragraphs: long enough to identify, and still in the source language.
  if (sourceLang && sourceLang !== targetLang) {
    tgt.forEach((p, i) => {
      if (words(p).length >= 8 && detected[i] === sourceLang) {
        findings.push({
          kind: "untranslated_segment",
          severity: "critical",
          confidence: "high",
          message: `Paragraph ${i + 1} of the deliverable is still in the source language (${sourceLang}).`,
          target_segment: i,
          evidence: { target: snippet(p) },
        });
      }
    });
  }

  if (sourceLang && targetLang) {
    findings.push(...compareValues(src, tgt, sourceLang, targetLang));
  }

  const injected = injectionPhrases(input.target, input.source);
  if (injected.length > 0) {
    const sourceToo = injectionPhrases(input.source, "").length > 0;
    findings.push({
      kind: "injection_suspected",
      severity: "critical",
      confidence: sourceToo ? "medium" : "high",
      message: `The deliverable contains text addressed to the verifier: "${injected.join('", "')}".`,
      evidence: { target: injected.join(" | ") },
    });
  }

  return { languages, sourceParagraphs: src, targetParagraphs: tgt, findings };
}

/**
 * Numbers and dates must survive translation. When both sides have an unmatched value, one was
 * changed (high confidence). When only one side does, it may just be written out in words
 * ("thirty days"), so it's medium confidence and left for the judges.
 */
function compareValues(src: string[], tgt: string[], sl: Lang, tl: Lang): Finding[] {
  const aligned = src.length === tgt.length;
  const pairs: [string, string, number | undefined][] = aligned
    ? src.map((s, i) => [s, tgt[i] ?? "", i])
    : [[src.join("\n\n"), tgt.join("\n\n"), undefined]];

  const findings: Finding[] = [];
  for (const [s, t, i] of pairs) {
    const a = extract(s, sl);
    const b = extract(t, tl);
    const where = i === undefined ? "" : ` in paragraph ${i + 1}`;
    const local = i === undefined ? {} : { source_segment: i, target_segment: i };
    const evidence = { source: snippet(s), target: snippet(t) };

    for (const [kind, label, from, to] of [
      ["date_mismatch", "date", a.dates, b.dates],
      ["number_mismatch", "number", a.numbers, b.numbers],
    ] as const) {
      const missing = missingFrom(from, to);
      const extra = missingFrom(to, from);
      if (missing.length === 0 && extra.length === 0) continue;
      const changed = missing.length > 0 && extra.length > 0;
      findings.push({
        kind,
        severity: "critical",
        confidence: changed ? "high" : "medium",
        message: changed
          ? `A ${label} differs${where}: source has ${missing.join(", ")}, deliverable has ${extra.join(", ")}.`
          : missing.length > 0
            ? `Source ${label}(s) ${missing.join(", ")}${where} not found in the deliverable (may be written out in words).`
            : `Deliverable has ${label}(s) ${extra.join(", ")}${where} not in the source.`,
        ...local,
        evidence,
      });
    }
  }
  return findings;
}

function mostCommon<T>(xs: (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) if (x !== null) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [x, c] of counts) {
    if (c > n) {
      best = x;
      n = c;
    }
  }
  return best;
}
