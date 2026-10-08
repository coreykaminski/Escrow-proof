import { LANGS, type Lang } from "../types.ts";

/** Paragraphs: blocks separated by one or more blank lines, trimmed, empties dropped. */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-zà-öø-ÿß]+(?:['’][a-zà-öø-ÿ]+)?/g) ?? [];
}

/** High-frequency function words; enough to tell these four languages apart on a paragraph. */
const STOPWORDS: Record<Lang, Set<string>> = {
  en: new Set(
    "the of and to in is that for it with as on be by this are or not from at an which shall will any all such its has have was were their party agreement".split(
      " ",
    ),
  ),
  es: new Set(
    "el la de que y en los las del se por con una para es su al lo como más pero sus le ya o este esta ha entre cuando muy sin sobre también parte acuerdo será dicha".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les de des du et en un une est que qui dans pour pas sur au aux par ce cette ses son sont avec ou il elle être sera toute tout partie accord".split(
      " ",
    ),
  ),
  de: new Set(
    "der die das und in den von zu mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach bei einer um wird oder vertrag partei".split(
      " ",
    ),
  ),
};

/** Most likely language by stopword hits, or null when the text is too short to tell. */
export function detectLang(text: string): Lang | null {
  const ws = words(text);
  if (ws.length < 6) return null;
  let best: Lang | null = null;
  let bestScore = 0;
  let second = 0;
  for (const lang of LANGS) {
    const score = ws.filter((w) => STOPWORDS[lang].has(w)).length;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > second) {
      second = score;
    }
  }
  // Require a clear winner so mixed or name-heavy paragraphs don't flip-flop.
  return bestScore >= 2 && bestScore >= second * 1.5 ? best : null;
}

/**
 * Phrases that address the verifier rather than the reader, in the four languages. A real
 * translation of a document that itself talks about reviewers would also contain them, so the
 * check only counts phrases that appear in the deliverable but not in the source.
 */
export const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|criteria|rules)/i,
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(reviewer|verifier|evaluator|grader|judge|assistant|ai|model|llm)\b/i,
  /\b(mark|rate|grade|treat|consider)\s+(this|the)\s+(translation|deliverable|document|text|work)\s+as\s+(accurate|correct|passed|passing|complete|approved|compliant)/i,
  /\b(all|every)\s+(criteria|criterion|checks?)\s+(are|is|have been)\s+(met|satisfied|passed)\b/i,
  /\b(language\s+model|system\s+prompt|as\s+an\s+ai)\b/i,
  /\bignor(a|e|ez|ar)\s+(todas\s+|toutes\s+)?(las|les)\s+(instrucciones|instructions)\s+(anteriores|précédentes|precedentes)/i,
  /\bnota\s+para\s+el\s+(revisor|evaluador|verificador)/i,
  /\bmar(ca|que|quez|car|quer)\s+(esta|la|cette)\s+traducci[oó]n|\bmar(que|quez|quer)\s+(cette|la)\s+traduction/i,
  /\bnote\s+(au|à\s+l['’]attention\s+du|pour\s+le)\s+(relecteur|vérificateur|verificateur|évaluateur|evaluateur|correcteur)/i,
  /\bignorier(e|en)?\s+(alle\s+)?(vorherigen|obigen|bisherigen)\s+anweisungen/i,
  /\bhinweis\s+(an|für)\s+(den|die)\s+(prüfer|pruefer|gutachter|bewerter|reviewer)/i,
  /\b(markiere|markieren|bewerte|bewerten)\s+(sie\s+)?(diese|die)\s+übersetzung\s+als/i,
];

export function injectionPhrases(target: string, source: string): string[] {
  const hits: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(target);
    if (m && !re.test(source)) hits.push(m[0]);
  }
  return hits;
}
