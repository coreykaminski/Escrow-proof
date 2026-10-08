/** Part 9: public status and pricing pages, scheduler heartbeat, ledger check. */
import { afterEach, describe, expect, it } from "vitest";
import { checkLedger } from "../src/services/status.ts";
import { createHarness, type Harness, HOUR } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("status", () => {
  it("reports the scheduler from its heartbeat and the ledger from its last check", async () => {
    h = await createHarness();
    const before = (await h.call(null, "GET", "/status.json")).body;
    const byName = (s: { components: { name: string; status: string }[] }, prefix: string) =>
      s.components.find((c) => c.name.startsWith(prefix))?.status;
    expect(byName(before, "Scheduler")).toBe("down");
    expect(byName(before, "Ledger")).toBe("degraded");
    expect(byName(before, "Card payments")).toBe("not_configured");

    await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
    await checkLedger(h.handle.db, h.clock.now);
    const after = (await h.call(null, "GET", "/status.json")).body;
    expect(byName(after, "Scheduler")).toBe("operational");
    expect(byName(after, "Ledger")).toBe("operational");
    expect(after.status).toBe("operational");

    h.clock.advance(HOUR);
    const stale = await h.call(null, "GET", "/status.json");
    expect(byName(stale.body, "Scheduler")).toBe("down");
    expect(stale.status).toBe(503);
  });

  it("renders the HTML page without exposing customer data", async () => {
    h = await createHarness();
    const html = await (await h.fetch("http://x/status")).text();
    expect(html).toContain("Proof Desk status");
    expect(html).not.toMatch(/acct_|agr_|pd_test_/);
  });
});

describe("pricing page", () => {
  it("shows the prices the billing code charges", async () => {
    h = await createHarness();
    const html = await (await h.fetch("http://x/pricing")).text();
    expect(html).toContain("2% of the released amount");
    expect(html).toContain("$0.50");
    expect(html).toContain("$250");
    expect(html).toContain("$25 or 5%");
    expect(html).toContain("$3 per check");
  });
});
