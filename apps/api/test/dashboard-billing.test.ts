/** The platform's usage and billing page in the dashboard. */
import { newId } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function signIn(key: string) {
  const login = await h.fetch("http://x/dashboard/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `api_key=${encodeURIComponent(key)}`,
    redirect: "manual",
  });
  return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("usage and billing page", () => {
  it("shows this month's charges, totals and invoices, and saves the billing email", async () => {
    h = await createHarness();
    const [live] = await h.handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.name, "Live Platform"));
    const accountId = live?.id as string;
    await h.handle.db.insert(schema.billingEvents).values([
      {
        id: newId("billingEvent"),
        accountId,
        kind: "verification",
        ref: "v1",
        livemode: true,
        amount: 150,
        description: "Verification: translation",
        period: "2026-10",
        occurredAt: h.clock.now,
      },
      {
        id: newId("billingEvent"),
        accountId,
        kind: "dispute",
        ref: "d1",
        livemode: true,
        amount: 2_500,
        description: "Dispute resolution, agr_x (losing party: buyer)",
        period: "2026-10",
        occurredAt: h.clock.now,
      },
    ]);
    await h.handle.db.insert(schema.invoices).values({
      id: newId("invoice"),
      accountId,
      period: "2026-09",
      stripeInvoiceId: "in_1",
      status: "open",
      total: 9_900,
      hostedUrl: "https://invoice.stripe.com/i/abc",
      lines: [],
      createdAt: h.clock.now,
    });

    const cookie = await signIn(h.keys.live);
    const page = await (
      await h.fetch("http://x/dashboard/billing", { headers: { cookie } })
    ).text();
    expect(page).toContain("Usage and billing");
    expect(page).toContain("$26.50"); // invoiced total this month
    expect(page).toContain("Dispute resolution, agr_x");
    expect(page).toContain("https://invoice.stripe.com/i/abc");

    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const save = async (email: string) =>
      h.fetch("http://x/dashboard/billing/settings", {
        method: "POST",
        headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, email }).toString(),
      });
    expect((await save("not-an-email")).status).toBe(400);
    const ok = await save("billing@live.example");
    expect(await ok.text()).toContain("Invoices will go to billing@live.example");
    const [after] = await h.handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId));
    expect(after?.billingEmail).toBe("billing@live.example");

    // Another platform sees only its own (empty) billing.
    const other = await signIn(h.keys.platformB);
    const theirs = await (
      await h.fetch("http://x/dashboard/billing", { headers: { cookie: other } })
    ).text();
    expect(theirs).toContain("No charges in 2026-10");
    expect(theirs).not.toContain("invoice.stripe.com");
  });

  it("requires a session and a valid form token", async () => {
    h = await createHarness();
    const anon = await h.fetch("http://x/dashboard/billing", { redirect: "manual" });
    expect(anon.status).toBe(302);
    const cookie = await signIn(h.keys.platformA);
    const forged = await h.fetch("http://x/dashboard/billing/settings", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "wrong", email: "a@b.example" }).toString(),
    });
    expect(forged.status).toBe(403);
  });
});
