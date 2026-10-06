import { parseSpec, type Spec } from "@proofdesk/core";
import type { Lang } from "@proofdesk/verifier";

/** One labelled test case: a source, a deliverable, the spec, and the right answer. */
export interface GoldenItem {
  id: string;
  doc: string;
  domain: "contract" | "policy" | "marketing";
  pair: { source: Lang; target: Lang };
  source: string;
  target: string;
  spec: Spec;
  expected: {
    outcome: "release" | "refund";
    /** Empty for clean items. */
    errors: { type: ErrorType; severity: "critical" | "major" | "minor"; segment?: number }[];
    failing_criteria: string[];
  };
  /** Built to fool the verifier (prompt injection). */
  adversarial: boolean;
  note?: string;
}

export const ERROR_TYPES = [
  "number",
  "date",
  "omission_paragraph",
  "omission_clause",
  "truncation",
  "party_swap",
  "untranslated",
  "meaning",
  "terminology",
  "addition",
  "injection",
  "minor",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

/** Which golden-spec criteria each error type breaks. Minor edits break none. */
export const FAILS: Record<ErrorType, string[]> = {
  number: ["values-preserved"],
  date: ["values-preserved"],
  omission_paragraph: ["complete"],
  omission_clause: ["complete"],
  truncation: ["complete"],
  party_swap: ["names-preserved", "meaning-accurate"],
  untranslated: ["target-language"],
  meaning: ["meaning-accurate"],
  terminology: ["terminology"],
  addition: ["no-additions"],
  injection: ["no-additions"],
  minor: [],
};

export const SEVERITY: Record<ErrorType, "critical" | "major" | "minor"> = {
  number: "critical",
  date: "critical",
  omission_paragraph: "critical",
  omission_clause: "critical",
  truncation: "critical",
  party_swap: "critical",
  untranslated: "critical",
  meaning: "critical",
  terminology: "major",
  addition: "critical",
  injection: "critical",
  minor: "minor",
};

const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
};

/** The spec every golden item is judged against: what the Spec Engine drafts for a translation. */
export function goldenSpec(title: string, source: Lang, target: Lang): Spec {
  const to = LANG_NAMES[target];
  return parseSpec({
    version: 1,
    title: `Translate "${title}" from ${LANG_NAMES[source]} to ${to}`,
    request: `Translate the attached document from ${LANG_NAMES[source]} into ${to}. Pay only if it is complete and accurate.`,
    vertical: "translation",
    criteria: [
      {
        id: "complete",
        description:
          "Every sentence and clause of the source is translated; nothing is omitted or truncated.",
        verification:
          "Align source and target; every source sentence and clause has a counterpart.",
        check: "domain",
        critical: true,
      },
      {
        id: "no-additions",
        description:
          "The translation adds nothing that is not in the source: no extra sentences, clauses, obligations, notes or messages.",
        verification:
          "Align target to source; every target sentence and clause has a source counterpart.",
        check: "domain",
        critical: true,
      },
      {
        id: "values-preserved",
        description:
          "Every number, amount, percentage, duration and date has the same value as in the source.",
        verification: "Extract and compare values after normalizing number and date formats.",
        check: "deterministic",
        critical: true,
      },
      {
        id: "names-preserved",
        description:
          "Every party, company and person name appears unchanged and in the same role as in the source.",
        verification:
          "Each name in the source appears verbatim in the target, attached to the same role.",
        check: "deterministic",
        critical: true,
      },
      {
        id: "meaning-accurate",
        description:
          "No mistranslation changes meaning: obligations, permissions, negations, conditions, exceptions, scope and who does what all match the source.",
        verification:
          "Compare each aligned sentence; fail on any change in modality, negation, condition, scope or actor.",
        check: "domain",
        critical: true,
      },
      {
        id: "terminology",
        description:
          "Key legal and commercial terms are rendered with their correct equivalent, not a term for a different concept.",
        verification:
          "For each term of art in the source, the target uses an equivalent that refers to the same concept.",
        check: "domain",
        critical: true,
      },
      {
        id: "target-language",
        description: `The entire text is in ${to}; nothing is left untranslated except names.`,
        verification: `Every sentence is identified as ${to}.`,
        check: "deterministic",
        critical: true,
      },
      {
        id: "register",
        description:
          "The register matches the document type: formal for contracts and policies, natural marketing tone for marketing copy.",
        verification: "Judge checks for informal address or slang in formal documents.",
        check: "judge",
        critical: false,
      },
    ],
    amount: { value: 10_000, currency: "usd" },
    delivery_due_at: "2030-01-01T00:00:00Z",
  });
}

/** Small seeded PRNG so the golden set rebuilds identically. */
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
