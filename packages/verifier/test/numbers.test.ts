import { describe, expect, it } from "vitest";
import { canonicalNumber, extract, missingFrom } from "../src/translation/numbers.ts";

describe("dates normalize across languages", () => {
  it.each([
    ["en", "Signed on March 3, 2026 in Boston.", ["2026-03-03"]],
    ["en", "Effective 3rd March 2026.", ["2026-03-03"]],
    ["en", "Due 03/04/2026.", ["2026-03-04"]],
    ["en", "Starting in June 2027.", ["2027-06"]],
    ["es", "Firmado el 3 de marzo de 2026.", ["2026-03-03"]],
    ["es", "Vence el 1.º de julio del 2026.", ["2026-07-01"]],
    ["es", "Vence el 04/03/2026.", ["2026-03-04"]],
    ["fr", "Signé le 3 mars 2026.", ["2026-03-03"]],
    ["fr", "À compter du 1er août 2026.", ["2026-08-01"]],
    ["de", "Unterzeichnet am 3. März 2026.", ["2026-03-03"]],
    ["de", "Fällig am 04.03.2026.", ["2026-03-04"]],
    ["de", "Ab Juni 2027.", ["2027-06"]],
  ] as const)("%s: %s", (lang, text, dates) => {
    expect(extract(text, lang).dates).toEqual(dates);
  });

  it("doesn't count a parsed date's parts as numbers", () => {
    expect(extract("On March 3, 2026 pay 500.", "en")).toEqual({
      dates: ["2026-03-03"],
      numbers: ["500"],
    });
  });
});

describe("numbers normalize across languages", () => {
  it.each([
    ["en", "$1,500.00", "1500"],
    ["es", "1.500,00 $", "1500"],
    ["de", "1.500,00 €", "1500"],
    ["fr", "1 500,00 €", "1500"],
    ["fr", "1 500,00 €", "1500"],
    ["en", "2.5%", "2.5"],
    ["es", "2,5 %", "2.5"],
    ["en", "Section 3.2", "3.2"],
    ["es", "Cláusula 3.2", "3.2"],
    ["de", "Ziffer 3.2", "3.2"],
    ["en", "1,000,000", "1000000"],
    ["de", "1.000.000", "1000000"],
  ] as const)("%s %s → %s", (lang, text, n) => {
    expect(extract(text, lang).numbers).toEqual([n]);
  });

  it("keeps clock times as tokens", () => {
    expect(extract("before 17:00 CET", "en").numbers).toEqual(["17:00"]);
  });

  it("canonicalizes leading zeros", () => {
    expect(canonicalNumber("007", "en")).toBe("7");
  });
});

describe("missingFrom", () => {
  it("is a multiset difference", () => {
    expect(missingFrom(["30", "30", "5"], ["30", "5"])).toEqual(["30"]);
    expect(missingFrom(["1"], ["1", "1"])).toEqual([]);
  });
});
