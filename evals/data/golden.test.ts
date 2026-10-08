/** CI gate for the data/research verifier (free, offline): the whole golden set. */
import { describe, expect, it } from "vitest";
import { loadGolden, runItem } from "./run.ts";

describe("data verifier on the golden set", () => {
  it.each(loadGolden().map((i) => [i.id, i] as const))("%s", async (_id, item) => {
    const row = await runItem(item);
    expect(row.error).toBeUndefined();
    if (item.expected === "release") expect(row.got).toBe("release");
    else expect(row.got).not.toBe("release");
    if (!item.adversarial) expect(row.got).toBe(item.expected);
  });
});
