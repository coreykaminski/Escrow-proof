import { describe, expect, it } from "vitest";
import { parseSpec, type SpecInput, specHash } from "../src/spec.ts";

const base: SpecInput = {
  version: 1,
  title: "Translate NDA EN→ES",
  request: "Translate this NDA into Spanish, legal register.",
  vertical: "translation",
  criteria: [
    {
      id: "numbers",
      description: "All numbers, dates and amounts preserved",
      check: "deterministic",
      critical: true,
    },
    { id: "complete", description: "Every clause translated, nothing omitted", check: "domain" },
  ],
  amount: { value: 18_000, currency: "usd" },
  delivery_due_at: "2026-10-10T17:00:00Z",
};

describe("spec", () => {
  it("applies defaults", () => {
    const spec = parseSpec(base);
    expect(spec.appeal_window_hours).toBe(72);
    expect(spec.criteria[1]?.critical).toBe(false);
  });

  it("normalizes the deadline so equivalent timestamps hash the same", () => {
    const a = parseSpec(base);
    const b = parseSpec({ ...base, delivery_due_at: "2026-10-10T19:00:00+02:00" });
    expect(a.delivery_due_at).toBe("2026-10-10T17:00:00.000Z");
    expect(specHash(a)).toBe(specHash(b));
  });

  it("changes hash when any term changes", () => {
    const a = specHash(parseSpec(base));
    expect(specHash(parseSpec({ ...base, amount: { value: 18_001, currency: "usd" } }))).not.toBe(
      a,
    );
    expect(specHash(parseSpec({ ...base, title: "Other" }))).not.toBe(a);
  });

  it("rejects duplicate criterion ids", () => {
    const criteria = [base.criteria[0], { ...base.criteria[0] }];
    expect(() => parseSpec({ ...base, criteria })).toThrow(/duplicate criterion id/);
  });

  it.each([
    ["non-integer amount", { amount: { value: 10.5, currency: "usd" } }],
    ["zero amount", { amount: { value: 0, currency: "usd" } }],
    ["uppercase currency", { amount: { value: 100, currency: "USD" } }],
    ["no criteria", { criteria: [] }],
    ["deadline without timezone", { delivery_due_at: "2026-10-10T17:00:00" }],
    ["appeal window over 30 days", { appeal_window_hours: 721 }],
    ["unknown vertical", { vertical: "astrology" }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseSpec({ ...base, ...patch })).toThrow();
  });
});
