import { describe, expect, it } from "vitest";
import { assembleSpec, normalizeCriterionId, type SpecTerms } from "../src/assemble.ts";
import type { DraftOutput } from "../src/drafter.ts";
import { SpecDraftError } from "../src/drafter.ts";

const terms: SpecTerms = {
  request: "Translate the NDA into Spanish",
  amount: { value: 18_000, currency: "usd" },
  delivery_due_at: "2026-10-10T12:00:00Z",
};

const criterion = (over: Partial<DraftOutput["criteria"][number]> = {}) => ({
  id: "complete",
  description: "Every clause is translated",
  verification: "Align segments; none unmatched",
  check: "domain" as const,
  critical: true,
  ...over,
});

const draft = (over: Partial<DraftOutput> = {}): DraftOutput => ({
  title: "NDA EN→ES",
  vertical: "translation",
  criteria: [criterion()],
  open_questions: [],
  ...over,
});

describe("assembleSpec", () => {
  it("builds a valid spec with money terms from the caller only", () => {
    const spec = assembleSpec(draft(), terms);
    expect(spec).toMatchObject({
      version: 1,
      title: "NDA EN→ES",
      request: terms.request,
      vertical: "translation",
      amount: { value: 18_000, currency: "usd" },
      delivery_due_at: "2026-10-10T12:00:00.000Z",
      appeal_window_hours: 72,
    });
    expect(spec.criteria[0]).toEqual({
      id: "complete",
      description: "Every clause is translated",
      verification: "Align segments; none unmatched",
      check: "domain",
      critical: true,
    });
  });

  it("lets the caller's title and vertical override the draft", () => {
    const spec = assembleSpec(draft(), { ...terms, title: "My title", vertical: "general" });
    expect(spec.title).toBe("My title");
    expect(spec.vertical).toBe("general");
  });

  it("normalizes and de-duplicates criterion ids", () => {
    const spec = assembleSpec(
      draft({
        criteria: [
          criterion({ id: "Numbers Preserved!" }),
          criterion({ id: "numbers preserved" }),
          criterion({ id: "" }),
          criterion({ id: "x".repeat(80) }),
          criterion({ id: "x".repeat(80) }),
        ],
      }),
      terms,
    );
    expect(spec.criteria.map((c) => c.id)).toEqual([
      "numbers-preserved",
      "numbers-preserved-2",
      "criterion",
      "x".repeat(64),
      `${"x".repeat(62)}-2`,
    ]);
  });

  it("drops empty criteria and blank verification", () => {
    const spec = assembleSpec(
      draft({ criteria: [criterion({ description: "  " }), criterion({ verification: " " })] }),
      terms,
    );
    expect(spec.criteria).toHaveLength(1);
    expect(spec.criteria[0]).not.toHaveProperty("verification");
  });

  it("rejects a draft with no usable criteria", () => {
    expect(() => assembleSpec(draft({ criteria: [] }), terms)).toThrow(SpecDraftError);
  });

  it("reports a draft that can't form a valid spec as invalid_draft", () => {
    try {
      assembleSpec(draft({ criteria: [criterion({ description: "x".repeat(2001) })] }), terms);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecDraftError);
      expect((err as SpecDraftError).code).toBe("invalid_draft");
    }
  });
});

describe("normalizeCriterionId", () => {
  it.each([
    ["No Omissions", "no-omissions"],
    ["--edge__", "edge"],
    ["café_ñ", "cafe_n"],
    ["日本語", "criterion"],
  ])("%s → %s", (raw, id) => {
    expect(normalizeCriterionId(raw)).toBe(id);
  });
});
