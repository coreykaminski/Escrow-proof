import { lintSpec, parseSpec } from "@proofdesk/core";
import { describe, expect, it } from "vitest";
import {
  buildFromTemplate,
  SPEC_TEMPLATES,
  TemplateError,
  templateCatalog,
} from "../src/templates.ts";

const PARAMS: Record<string, Record<string, unknown>> = {
  "code.acceptance-tests": { task: "Write slugify(s) as an ES module.", hidden_tests: true },
  "data.dataset": {
    task: "List EU capitals with population.",
    min_records: 27,
    unique_key: "city",
  },
  "research.cited-brief": { task: "Summarize evidence on four-day weeks.", min_sources: 4 },
  "translation.document": { source_language: "en", target_language: "es", register: "legal" },
};

describe("spec templates", () => {
  it.each(SPEC_TEMPLATES.map((t) => t.id))("%s builds a valid, lint-clean spec", (id) => {
    const built = buildFromTemplate(id, PARAMS[id]);
    const spec = parseSpec({
      version: 1,
      title: built.title,
      request: built.request,
      vertical: built.vertical,
      criteria: built.criteria,
      amount: { value: 1, currency: "usd" },
      delivery_due_at: "2026-11-01T00:00:00Z",
    });
    expect(lintSpec(spec)).toEqual([]);
    expect(built.template).toEqual({ id, version: 1 });
  });

  it("puts the params into the criteria the verifiers read", () => {
    const data = buildFromTemplate("data.dataset", PARAMS["data.dataset"]);
    expect(data.criteria.map((c) => c.id)).toEqual([
      "matches-schema",
      "record-count",
      "unique-records",
    ]);
    expect(data.criteria[1]?.description).toBe("At least 27 records");
    const code = buildFromTemplate("code.acceptance-tests", { task: "Write f()." });
    expect(code.criteria.map((c) => c.id)).toEqual(["public-tests"]);
    expect(
      buildFromTemplate("research.cited-brief", PARAMS["research.cited-brief"]).criteria[0]
        ?.description,
    ).toContain("at least 4 sources");
    const tr = buildFromTemplate("translation.document", PARAMS["translation.document"]);
    expect(tr.title).toBe("Translate English → Spanish");
    expect(tr.criteria.at(-1)).toMatchObject({ id: "register", check: "judge" });
  });

  it("rejects unknown templates and bad params", () => {
    expect(() => buildFromTemplate("nope", {})).toThrow(TemplateError);
    try {
      buildFromTemplate("data.dataset", { task: "x list", min_records: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as TemplateError).code).toBe("invalid_params");
    }
  });

  it("publishes each template's params as JSON Schema", () => {
    const catalog = templateCatalog();
    expect(catalog.map((t) => t.id)).toEqual(SPEC_TEMPLATES.map((t) => t.id));
    const data = catalog.find((t) => t.id === "data.dataset");
    expect(data?.params).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["task", "min_records"]),
    });
  });
});
