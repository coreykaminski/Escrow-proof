import type { Lang } from "../types.ts";

/**
 * Extracts the dates and numbers a translation must preserve, normalized so that the same value
 * compares equal across languages: "March 3, 2026" = "3 de marzo de 2026" = "3. März 2026",
 * "$1,500.00" = "1.500,00 $" = "1 500,00 $".
 */

const MONTHS: Record<Lang, string[][]> = {
  en: [
    ["january", "jan"],
    ["february", "feb"],
    ["march", "mar"],
    ["april", "apr"],
    ["may"],
    ["june", "jun"],
    ["july", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["october", "oct"],
    ["november", "nov"],
    ["december", "dec"],
  ],
  es: [
    ["enero"],
    ["febrero"],
    ["marzo"],
    ["abril"],
    ["mayo"],
    ["junio"],
    ["julio"],
    ["agosto"],
    ["septiembre", "setiembre"],
    ["octubre"],
    ["noviembre"],
    ["diciembre"],
  ],
  fr: [
    ["janvier"],
    ["février", "fevrier"],
    ["mars"],
    ["avril"],
    ["mai"],
    ["juin"],
    ["juillet"],
    ["août", "aout"],
    ["septembre"],
    ["octobre"],
    ["novembre"],
    ["décembre", "decembre"],
  ],
  de: [
    ["januar", "jänner"],
    ["februar"],
    ["märz", "maerz"],
    ["april"],
    ["mai"],
    ["juni"],
    ["juli"],
    ["august"],
    ["september"],
    ["oktober"],
    ["november"],
    ["dezember"],
  ],
};

function monthIndex(lang: Lang, word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS[lang].findIndex((names) => names.includes(w));
  return i < 0 ? null : i + 1;
}

const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d?: number): string | null {
  if (m < 1 || m > 12 || y < 1000 || y > 2999) return null;
  if (d === undefined) return `${y}-${pad(m)}`;
  if (d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export interface Extracted {
  /** Normalized ISO dates (YYYY-MM-DD, or YYYY-MM when no day). */
  dates: string[];
  /** Canonical numeric strings ("1500", "2.5", "3.2"). */
  numbers: string[];
}

/** Regex group → number / string (groups in these patterns are never optional). */
const n = (g: string | undefined) => Number(g);
const s = (g: string | undefined) => g ?? "";

const MONTH_WORD = "([A-Za-zÀ-ÿ]+\\.?)";
const DAY = "(\\d{1,2})(?:st|nd|rd|th|er|º|\\.º)?";

/** Date patterns per language; each returns [regex, (match) => iso | null]. */
function datePatterns(lang: Lang): [RegExp, (m: RegExpExecArray) => string | null][] {
  const common: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => iso(n(m[1]), n(m[2]), n(m[3]))],
  ];
  // Numeric dates: month-first in English, day-first elsewhere. Dots are German style.
  const numeric: [RegExp, (m: RegExpExecArray) => string | null] = [
    /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g,
    (m) => (lang === "en" ? iso(n(m[3]), n(m[1]), n(m[2])) : iso(n(m[3]), n(m[2]), n(m[1]))),
  ];
  const byLang: Record<Lang, [RegExp, (m: RegExpExecArray) => string | null][]> = {
    en: [
      // March 3, 2026 / March 3rd 2026
      [
        new RegExp(`\\b${MONTH_WORD}\\s+${DAY},?\\s+(\\d{4})\\b`, "g"),
        (m) => withMonth(lang, s(m[1]), (mo) => iso(n(m[3]), mo, n(m[2]))),
      ],
      // 3 March 2026
      [
        new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH_WORD},?\\s+(\\d{4})\\b`, "g"),
        (m) => withMonth(lang, s(m[2]), (mo) => iso(n(m[3]), mo, n(m[1]))),
      ],
    ],
    es: [
      [
        new RegExp(`\\b${DAY}\\s+de\\s+${MONTH_WORD}\\s+(?:de|del)\\s+(\\d{4})\\b`, "gi"),
        (m) => withMonth(lang, s(m[2]), (mo) => iso(n(m[3]), mo, n(m[1]))),
      ],
    ],
    fr: [
      [
        new RegExp(`\\b${DAY}\\s+${MONTH_WORD}\\s+(\\d{4})\\b`, "gi"),
        (m) => withMonth(lang, s(m[2]), (mo) => iso(n(m[3]), mo, n(m[1]))),
      ],
    ],
    de: [
      [
        new RegExp(`\\b(\\d{1,2})\\.\\s*${MONTH_WORD}\\s+(\\d{4})\\b`, "gi"),
        (m) => withMonth(lang, s(m[2]), (mo) => iso(n(m[3]), mo, n(m[1]))),
      ],
    ],
  };
  // Month + year with no day: "March 2026", "marzo de 2026", "mars 2026", "März 2026".
  const monthYear: [RegExp, (m: RegExpExecArray) => string | null] = [
    new RegExp(`\\b${MONTH_WORD}\\s+(?:de\\s+)?(\\d{4})\\b`, "gi"),
    (m) => withMonth(lang, s(m[1]), (mo) => iso(n(m[2]), mo)),
  ];
  return [...common, ...byLang[lang], numeric, monthYear];
}

function withMonth(lang: Lang, word: string, f: (month: number) => string | null) {
  const mo = monthIndex(lang, word);
  return mo === null ? null : f(mo);
}

/** Number syntax per language: which separator groups thousands and which marks decimals. */
function numberPattern(lang: Lang): RegExp {
  switch (lang) {
    case "en":
      return /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
    case "es":
    case "de":
      return /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;
    case "fr":
      return /\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;
  }
}

/** "1.500,00" (es) → "1500"; "2,5" → "2.5"; "3.2" (a section number) stays "3.2". */
export function canonicalNumber(raw: string, lang: Lang): string {
  let s = raw.replace(/[   ]/g, "");
  if (lang === "en") {
    s = s.replace(/,(?=\d{3}(\D|$))/g, "");
  } else {
    // A dot followed by exactly three digits is grouping; a comma is the decimal mark.
    s = s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return String(n);
}

export function extract(text: string, lang: Lang): Extracted {
  const dates: string[] = [];
  let rest = text;
  for (const [re, toIso] of datePatterns(lang)) {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const value = toIso(m);
      if (value === null) return args[0] as string;
      dates.push(value);
      return " ";
    });
  }
  // Clock times and phone-like runs aren't amounts but must still match: keep them as tokens.
  const numbers: string[] = [];
  rest = rest.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
    numbers.push(`${+h}:${m}`);
    return " ";
  });
  for (const m of rest.matchAll(numberPattern(lang))) {
    numbers.push(canonicalNumber(m[0], lang));
  }
  return { dates, numbers };
}

/** Multiset difference: items in `a` not matched by an item in `b`. */
export function missingFrom(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = counts.get(x) ?? 0;
    if (n > 0) counts.set(x, n - 1);
    else out.push(x);
  }
  return out;
}
