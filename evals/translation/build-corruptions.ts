/**
 * Golden set step 2: realistic translation errors that deterministic checks can't see. For each
 * base document and each language, Claude rewrites single paragraphs with one labelled error
 * (meaning flip, wrong term, invented addition, dropped clause) or a harmless edit (minor).
 * Every corruption keeps all numbers, dates and names, so only the model layers can catch it.
 *
 *   npm run golden:corrupt -- [--only c01] [--concurrency 6]
 * Writes evals/translation/corruptions/<id>.json; existing files are skipped.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extract, missingFrom } from "@proofdesk/verifier";
import { z } from "zod";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import type { BaseDoc } from "./build-base.ts";
import { mapLimit, structured } from "./llm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const LANGS = ["en", "es", "fr", "de"] as const;
type L = (typeof LANGS)[number];

export const CORRUPTION_TYPES = [
  "meaning",
  "terminology",
  "addition",
  "omission",
  "minor",
] as const;
export type CorruptionType = (typeof CORRUPTION_TYPES)[number];

const CorruptionSchema = z.object({
  type: z.enum(CORRUPTION_TYPES),
  paragraph: z.number().int().describe("0-based index of the paragraph that was rewritten"),
  text: z.string().describe("The full rewritten paragraph"),
  description: z
    .string()
    .describe("In English: exactly what changed and why it is / isn't an error"),
});
const OutputSchema = z.object({
  en: z.array(CorruptionSchema),
  es: z.array(CorruptionSchema),
  fr: z.array(CorruptionSchema),
  de: z.array(CorruptionSchema),
});

export type Corruption = z.infer<typeof CorruptionSchema> & { lang: L };

const SYSTEM = `You create labelled test cases for a system that checks translations. You'll get a document as four aligned versions (English, Spanish, French, German), all correct.

For EACH language, produce rewritten single paragraphs of that language's version, as if the translator into that language had made exactly one specific change. Produce, per language:
- 2 × "meaning": a subtle error that changes legal or factual meaning while reading fluently: flip a negation, change "shall/must" to "may" (or reverse), drop or invert a condition or exception, change who does what, change scope ("all" → "some", "including" → "excluding").
- 1 × "terminology": translate one key term with a plausible but wrong term that changes what it refers to (e.g. "liquidated damages" → "punitive damages", "business days" → "calendar days", "deposit" → "down payment").
- 1 × "addition": add one plausible sentence or clause that is not in the original (an extra obligation, guarantee, fee waiver, or condition).
- 1 × "omission": silently remove one substantive clause or sentence from a paragraph that has more than one, leaving the rest fluent.
- 2 × "minor": a harmless edit that a careful reviewer would accept: a synonym, reordered clause, or punctuation change with identical meaning. These must NOT be errors.

Hard rules for every rewrite:
- Rewrite only one paragraph; return the full rewritten paragraph text.
- Keep every number, amount, percentage, date and name exactly as written in that paragraph (same digits, same format). The change must be in the words.
- Pick different paragraphs where possible.
- The description says precisely what changed.`;

function validate(doc: BaseDoc, lang: L, c: z.infer<typeof CorruptionSchema>): string | null {
  const original = doc.paragraphs[lang][c.paragraph];
  if (original === undefined) return "paragraph index out of range";
  if (c.text.trim() === original.trim()) return "text unchanged";
  const a = extract(original, lang);
  const b = extract(c.text, lang);
  const same = (x: string[], y: string[]) => [...x].sort().join("|") === [...y].sort().join("|");
  const changed = !same(a.dates, b.dates) || !same(a.numbers, b.numbers);
  // Additions may introduce a value and omissions may drop one; nothing may alter a value.
  const subset = (x: string[], y: string[]) => missingFrom(x, y).length === 0;
  if (changed && c.type === "omission") {
    if (!subset(b.dates, a.dates) || !subset(b.numbers, a.numbers)) return "values altered";
  } else if (changed && c.type !== "addition") {
    return "numbers or dates changed";
  }
  for (const name of doc.parties) {
    if (original.includes(name) && !c.text.includes(name)) return `name "${name}" dropped`;
  }
  return null;
}

async function buildOne(doc: BaseDoc) {
  const path = join(here, "corruptions", `${doc.id}.json`);
  if (existsSync(path)) return `${doc.id}: exists`;
  const versions = LANGS.map(
    (l) => `<${l}>\n${doc.paragraphs[l].map((p, i) => `[${i}] ${p}`).join("\n")}\n</${l}>`,
  ).join("\n\n");
  const { output } = await structured(OutputSchema, SYSTEM, versions);
  const kept: Corruption[] = [];
  const dropped: string[] = [];
  for (const lang of LANGS) {
    for (const c of output[lang]) {
      const problem = validate(doc, lang, c);
      if (problem) dropped.push(`${lang}/${c.type}: ${problem}`);
      else kept.push({ ...c, lang });
    }
  }
  writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`);
  return `${doc.id}: ${kept.length} kept${dropped.length ? `, dropped ${dropped.join("; ")}` : ""}`;
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: { only: { type: "string" }, concurrency: { type: "string", default: "6" } },
  });
  mkdirSync(join(here, "corruptions"), { recursive: true });
  const ids = values.only ? new Set(values.only.split(",")) : null;
  const docs: BaseDoc[] = readdirSync(join(here, "base"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(here, "base", f), "utf8")))
    .filter((d: BaseDoc) => !ids || ids.has(d.id));
  await mapLimit(docs, Number(values.concurrency), async (d) => {
    try {
      console.log(await buildOne(d));
    } catch (err) {
      console.log(`${d.id}: ERROR ${err instanceof Error ? err.message : err}`);
    }
  });
}

await main();
