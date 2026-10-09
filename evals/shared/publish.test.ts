/** The published accuracy file must match the committed runs exactly (run evals:publish). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPublished, PUBLISHED_PATH } from "./publish.ts";

describe("published accuracy v0", () => {
  it("is up to date with the committed eval runs", () => {
    const published = JSON.parse(readFileSync(PUBLISHED_PATH, "utf8"));
    expect(published).toEqual(JSON.parse(JSON.stringify(buildPublished())));
  });

  it("only publishes runs that met every target, or says so", () => {
    for (const s of buildPublished().suites) {
      for (const r of s.runs) expect(typeof r.pass).toBe("boolean");
      if (s.status === "pending") expect(s.runs).toEqual([]);
    }
  });
});
