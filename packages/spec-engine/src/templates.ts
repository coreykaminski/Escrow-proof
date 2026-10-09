import type { Spec } from "@proofdesk/core";
import { z } from "zod";

/**
 * Ready-made, checkable acceptance criteria for common jobs: an alternative to drafting a spec
 * with a model. Each template's criteria use the same ids and wording as the verifier's golden
 * sets, so the automated checks route to them exactly as they do in the measured evals, and the
 * deterministic ones decide without any model call.
 */
export interface SpecTemplate<P = Record<string, unknown>> {
  id: string;
  version: number;
  vertical: Spec["vertical"];
  name: string;
  description: string;
  /** What the buyer must attach as inputs for the checks to run. */
  inputs: string;
  params: z.ZodType<P>;
  build(p: P): Pick<Spec, "title" | "request" | "criteria">;
}

type Criterion = Spec["criteria"][number];
const critical = (id: string, description: string): Criterion => ({
  id,
  description,
  check: "deterministic",
  critical: true,
});

const task = z
  .string()
  .trim()
  .min(3)
  .max(2_000)
  .describe("What the deliverable must do, in a sentence or two");
const title = z.string().trim().min(1).max(200).optional().describe("Defaults to the task");
const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);

const codeTests = {
  id: "code.acceptance-tests",
  version: 1,
  vertical: "code",
  name: "Code that passes your tests",
  description:
    "Released only if the delivered code passes the buyer's acceptance tests in Proof Desk's sandbox, optionally plus held-out tests the seller never sees. Decided without a model.",
  inputs:
    "Attach the tests as inputs (e.g. tests/*.test.mjs or test_*.py). Tag each test name with the criterion it proves: [public-tests] or [hidden-tests]. Share only the public ones with the seller.",
  params: z.object({
    task,
    title,
    hidden_tests: z.boolean().default(false).describe("Also require the held-out [hidden-tests]"),
  }),
  build: (p: { task: string; title?: string | undefined; hidden_tests: boolean }) => ({
    title: p.title ?? short(p.task),
    request: p.task,
    criteria: [
      critical("public-tests", "Passes the public acceptance tests"),
      ...(p.hidden_tests
        ? [critical("hidden-tests", "Passes the buyer's held-out tests of the same behaviour")]
        : []),
    ],
  }),
} satisfies SpecTemplate<{ task: string; title?: string | undefined; hidden_tests: boolean }>;

const dataset = {
  id: "data.dataset",
  version: 1,
  vertical: "data",
  name: "Dataset that matches your schema",
  description:
    "Released only if every record is valid against the buyer's JSON Schema, there are enough records, and (optionally) no duplicates by a key field. JSON, JSONL or CSV. Decided without a model.",
  inputs:
    'Attach schema.json (JSON Schema for one record or the array). For the duplicate check, add "x-unique-keys": ["<key field>"] to the schema.',
  params: z.object({
    task,
    title,
    min_records: z.number().int().min(1).max(10_000_000),
    unique_key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Field that must be unique across records"),
  }),
  build: (p: {
    task: string;
    title?: string | undefined;
    min_records: number;
    unique_key?: string | undefined;
  }) => ({
    title: p.title ?? short(p.task),
    request: p.task,
    criteria: [
      critical(
        "matches-schema",
        "Every record has the required fields with the right types and formats",
      ),
      critical("record-count", `At least ${p.min_records} records`),
      ...(p.unique_key
        ? [critical("unique-records", `No two records share the same ${p.unique_key}`)]
        : []),
    ],
  }),
} satisfies SpecTemplate<{
  task: string;
  title?: string | undefined;
  min_records: number;
  unique_key?: string | undefined;
}>;

const research = {
  id: "research.cited-brief",
  version: 1,
  vertical: "data",
  name: "Research brief with checked citations",
  description:
    "Released only if the brief cites enough sources, every cited link loads, and every direct quote appears word for word in its source. Decided without a model.",
  inputs:
    "Nothing required. Tell the seller: put each direct quote in a paragraph that cites exactly one source (inline URL or [n] footnote), or it can't be checked automatically. Optionally attach snapshots of sources as sources/<name>.txt whose first line is `Source: <url>`; they're used instead of fetching.",
  params: z.object({
    task,
    title,
    min_sources: z.number().int().min(1).max(100).default(3),
  }),
  build: (p: { task: string; title?: string | undefined; min_sources: number }) => ({
    title: p.title ?? short(p.task),
    request: p.task,
    criteria: [
      critical(
        "cites-sources",
        `Cites at least ${p.min_sources} sources, and every cited link loads`,
      ),
      critical("quotes-verbatim", "Every direct quote appears word for word in the cited source"),
    ],
  }),
} satisfies SpecTemplate<{ task: string; title?: string | undefined; min_sources: number }>;

const LANGUAGES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
};

const translation = {
  id: "translation.document",
  version: 1,
  vertical: "translation",
  name: "Faithful document translation",
  description:
    "Released only if every number, date, amount and name survives, nothing is omitted or added, meaning is preserved, and the text is entirely in the target language; register is judged when requested. Meaning and register need the model layers.",
  inputs: "Attach the source document as a text input (text/plain or text/markdown).",
  params: z.object({
    task: task.optional(),
    title,
    source_language: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]),
    target_language: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]),
    register: z
      .enum(["legal", "formal", "neutral"])
      .optional()
      .describe("Adds a model-judged register criterion"),
  }),
  build: (p: {
    task?: string | undefined;
    title?: string | undefined;
    source_language: string;
    target_language: string;
    register?: "legal" | "formal" | "neutral" | undefined;
  }) => {
    const from = LANGUAGES[p.source_language];
    const to = LANGUAGES[p.target_language];
    return {
      title: p.title ?? `Translate ${from} → ${to}`,
      request: p.task ?? `Translate the attached ${from} document into ${to}.`,
      criteria: [
        critical(
          "values-preserved",
          "Every number, date, amount and party name matches the source exactly",
        ),
        {
          id: "no-omissions",
          description: "Every sentence and clause of the source is translated; nothing is omitted",
          verification:
            "Align source and target segment by segment; each source segment has a translated counterpart",
          check: "domain",
          critical: true,
        },
        {
          id: "no-additions",
          description: "Nothing is added that is not in the source",
          verification: "Each target segment corresponds to a segment of the source",
          check: "domain",
          critical: true,
        },
        {
          id: "meaning-preserved",
          description:
            "The meaning of every sentence matches the source, including obligations and negations",
          verification:
            "Annotators compare each segment with its source and cite any mistranslation",
          check: "judge",
          critical: true,
        },
        {
          id: "target-language",
          description: `Written entirely in ${to}; no untranslated passages`,
          check: "deterministic",
          critical: false,
        },
        ...(p.register
          ? [
              {
                id: "register",
                description: `${p.register[0]?.toUpperCase()}${p.register.slice(1)} register throughout`,
                verification: `A judge reads each paragraph and quotes any passage not in ${p.register} register`,
                check: "judge" as const,
                critical: false,
              },
            ]
          : []),
      ],
    };
  },
} satisfies SpecTemplate<{
  task?: string | undefined;
  title?: string | undefined;
  source_language: string;
  target_language: string;
  register?: "legal" | "formal" | "neutral" | undefined;
}>;

export const SPEC_TEMPLATES = [codeTests, dataset, research, translation] as const;

export class TemplateError extends Error {
  constructor(
    readonly code: "unknown_template" | "invalid_params",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

export function getTemplate(id: string) {
  return SPEC_TEMPLATES.find((t) => t.id === id);
}

/** The template's title, request, vertical and criteria for the given params. */
export function buildFromTemplate(id: string, params: unknown) {
  const t = getTemplate(id);
  if (!t) {
    throw new TemplateError(
      "unknown_template",
      `no template "${id}" (have: ${SPEC_TEMPLATES.map((x) => x.id).join(", ")})`,
    );
  }
  const parsed = (t.params as z.ZodType).safeParse(params ?? {});
  if (!parsed.success) {
    throw new TemplateError(
      "invalid_params",
      `invalid params for ${id}`,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const built = (t.build as (p: unknown) => Pick<Spec, "title" | "request" | "criteria">)(
    parsed.data,
  );
  return { template: { id: t.id, version: t.version }, vertical: t.vertical, ...built };
}

/** Public description of every template, with its params as JSON Schema. */
export function templateCatalog() {
  return SPEC_TEMPLATES.map((t) => ({
    id: t.id,
    version: t.version,
    vertical: t.vertical,
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    params: z.toJSONSchema(t.params as z.ZodType, { io: "input" }),
  }));
}
