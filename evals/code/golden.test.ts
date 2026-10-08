/**
 * CI gate for the code verifier (free: real sandbox, no model): every variant of two tasks gets
 * the right outcome. The full set runs with `npm run eval:code`.
 */
import { describe, expect, it } from "vitest";
import { loadGolden, runItem } from "./run.ts";

const items = loadGolden().filter((i) => i.task === "slugify" || i.task === "luhn");

describe("code verifier on the golden set", () => {
  it.each(items.map((i) => [i.id, i] as const))("%s", async (_id, item) => {
    const row = await runItem(item, { timeoutMs: 3_000 });
    expect(row.error).toBeUndefined();
    if (item.expected === "release") expect(row.got).toBe("release");
    else expect(row.got).not.toBe("release");
    // Honest broken work is refunded outright; only attacks may go to a human.
    if (!item.adversarial) expect(row.got).toBe(item.expected);
  });
});
