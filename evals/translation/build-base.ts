/**
 * Golden set step 1: base documents. For each brief, Claude writes an English source document and
 * paragraph-aligned professional translations into Spanish, French and German. A document is
 * accepted only if every translation (both directions) passes the deterministic checks and keeps
 * every party name verbatim, so the clean items in the golden set really are clean.
 *
 *   npm run golden:base -- [--only c01,p02] [--concurrency 6]
 * Writes evals/translation/base/<id>.json; existing files are skipped (re-run to resume).
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runDeterministic } from "@proofdesk/verifier";
import { z } from "zod";
import { loadEnv } from "../../apps/api/src/load-env.ts";
import { BRIEFS, type Brief } from "./briefs.ts";
import { mapLimit, structured } from "./llm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const LANGS = ["en", "es", "fr", "de"] as const;

const BaseDocSchema = z.object({
  title: z.string(),
  parties: z.array(z.string()).describe("Every person/company name exactly as written, 2-4 names"),
  paragraphs: z.object({
    en: z.array(z.string()),
    es: z.array(z.string()),
    fr: z.array(z.string()),
    de: z.array(z.string()),
  }),
});
export type BaseDoc = z.infer<typeof BaseDocSchema> & { id: string; domain: Brief["domain"] };

const SYSTEM = `You create test data for a translation-verification system: a realistic source document plus professional translations that are known to be correct.

Write the English source first, then translate it into Spanish (Spain), French (France) and German (Germany) as a careful professional legal/commercial translator would. The translations must be complete and faithful: same meaning, same obligations, same values, nothing added or omitted.

Hard rules (automated checks depend on them):
- 5 to 7 paragraphs. Each paragraph is 1-3 sentences. The translations have exactly the same number of paragraphs, aligned one-to-one; never merge or split paragraphs.
- Include concrete values: at least 4 numbers written with digits (amounts with currency, percentages, quantities, durations such as "30 days"), and at least 2 full dates with day, month and year. Never spell numbers out in words, in any language.
- Write dates with the month as a word: "March 3, 2026" in English, "3 de marzo de 2026", "3 mars 2026", "3. März 2026".
- Use each language's number format: 1,500.00 (en); 1.500,00 (es, de); 1 500,00 (fr). Keep the same currency; never convert.
- Include 2-4 named parties (companies and/or people). Write every name identically in all four languages, never translated. List them in "parties".
- No headings, no bullet lists, no section numbers.`;

async function buildOne(brief: Brief): Promise<{ id: string; status: string }> {
  const path = join(here, "base", `${brief.id}.json`);
  if (existsSync(path)) return { id: brief.id, status: "exists" };
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { output } = await structured(
      BaseDocSchema,
      SYSTEM,
      `Document type (${brief.domain}): ${brief.brief}.${
        lastProblems.length
          ? `\n\nA previous attempt failed these checks; avoid them:\n- ${lastProblems.join("\n- ")}`
          : ""
      }`,
    );
    const problems = validate(output);
    if (problems.length === 0) {
      const doc: BaseDoc = { id: brief.id, domain: brief.domain, ...output };
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
      return { id: brief.id, status: attempt === 1 ? "ok" : `ok (attempt ${attempt})` };
    }
    lastProblems = problems;
  }
  return { id: brief.id, status: `REJECTED: ${lastProblems.join("; ")}` };
}

function validate(doc: z.infer<typeof BaseDocSchema>): string[] {
  const problems: string[] = [];
  const n = doc.paragraphs.en.length;
  if (n < 4 || n > 8) problems.push(`English has ${n} paragraphs`);
  for (const lang of LANGS) {
    if (doc.paragraphs[lang].length !== n) {
      problems.push(`${lang} has ${doc.paragraphs[lang].length} paragraphs, en has ${n}`);
      continue;
    }
    const text = doc.paragraphs[lang].join("\n\n");
    for (const name of doc.parties) {
      if (!text.includes(name)) problems.push(`${lang} doesn't contain the name "${name}"`);
    }
    if (lang === "en") continue;
    const en = doc.paragraphs.en.join("\n\n");
    for (const [s, t, sl, tl] of [
      [en, text, "en", lang],
      [text, en, lang, "en"],
    ] as const) {
      const r = runDeterministic({ source: s, target: t, sourceLang: sl, targetLang: tl });
      for (const f of r.findings) problems.push(`${sl}→${tl}: ${f.message}`);
    }
  }
  return [...new Set(problems)];
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    options: { only: { type: "string" }, concurrency: { type: "string", default: "6" } },
  });
  const ids = values.only ? new Set(values.only.split(",")) : null;
  const briefs = BRIEFS.filter((b) => !ids || ids.has(b.id));
  const results = await mapLimit(briefs, Number(values.concurrency), async (b) => {
    try {
      const r = await buildOne(b);
      console.log(`${r.id}: ${r.status}`);
      return r;
    } catch (err) {
      console.log(`${b.id}: ERROR ${err instanceof Error ? err.message : err}`);
      return { id: b.id, status: "error" };
    }
  });
  const bad = results.filter((r) => !r.status.startsWith("ok") && r.status !== "exists");
  console.log(`\n${results.length - bad.length}/${results.length} base documents ready.`);
}

await main();
