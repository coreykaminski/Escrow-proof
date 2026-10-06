import { describe, expect, it } from "vitest";
import type { Spec } from "../src/spec.ts";
import { lintSpec } from "../src/spec-lint.ts";

type C = Spec["criteria"][number];
const crit = (over: Partial<C> = {}): C => ({
  id: "c1",
  description: "Every number, date and amount in the source appears unchanged in the translation",
  check: "deterministic",
  critical: true,
  ...over,
});
const codes = (criteria: C[]) => lintSpec({ criteria }).map((w) => w.code);

describe("lintSpec", () => {
  it("passes a concrete, verifiable spec", () => {
    expect(
      lintSpec({
        criteria: [
          crit(),
          crit({
            id: "c2",
            description: "Each source clause has a corresponding translated clause",
            verification: "Align source and target segments; no source segment is unmatched",
            check: "domain",
            critical: false,
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("flags vague wording with nothing observable", () => {
    const w = lintSpec({
      criteria: [
        crit(),
        crit({
          id: "tone",
          description: "The translation is high quality and professional",
          check: "deterministic",
        }),
      ],
    });
    expect(w).toContainEqual(
      expect.objectContaining({ code: "vague_wording", criterion_id: "tone" }),
    );
    expect(w.find((x) => x.code === "vague_wording")?.message).toContain("high quality");
  });

  it("accepts vague words when the criterion is anchored to something checkable", () => {
    expect(
      codes([
        crit({ description: "Professional register: no second-person informal pronouns (tú)" }),
      ]),
    ).not.toContain("vague_wording");
  });

  it("doesn't match vague terms inside other words", () => {
    expect(
      codes([crit({ description: "Property names in the JSON keep their casing" })]),
    ).not.toContain("vague_wording");
  });

  it("asks non-deterministic criteria to say how they're checked", () => {
    expect(codes([crit({ check: "judge" })])).toContain("no_verification");
    expect(
      codes([crit({ check: "judge", verification: "Judge quotes each informal pronoun" })]),
    ).not.toContain("no_verification");
    expect(codes([crit({ check: "deterministic" })])).not.toContain("no_verification");
  });

  it("flags overlong criteria", () => {
    expect(codes([crit({ description: `Every clause ${"x".repeat(400)}` })])).toContain("too_long");
  });

  it("flags specs with no critical criterion, a single criterion, or mostly judge checks", () => {
    expect(codes([crit({ critical: false }), crit({ id: "c2", critical: false })])).toContain(
      "no_critical_criterion",
    );
    expect(codes([crit()])).toContain("single_criterion");
    const judged = (id: string) =>
      crit({ id, check: "judge", verification: "Judge cites every instance" });
    expect(codes([crit(), judged("a"), judged("b")])).toContain("mostly_judge");
    expect(codes([crit(), crit({ id: "c2" }), judged("a")])).not.toContain("mostly_judge");
  });
});
