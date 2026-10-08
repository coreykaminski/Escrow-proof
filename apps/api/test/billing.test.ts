/** Part 9 billing: usage events, monthly invoices (Stripe Billing) and reviewer payouts. */
import { newId } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { FakeGateway } from "@proofdesk/payments";
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
let gw: FakeGateway;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  h = await createHarness({
    payments: (now) => {
      gw = new FakeGateway({ now });
      return gw;
    },
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
  });
}

const A = () => h.keys.platformA;
const O = () => h.keys.ops;
const NOV = new Date("2026-11-01T00:00:05Z");

async function funded(spec = specFixture(), inputs: unknown[] = []) {
  const agr = (
    await h.call(A(), "POST", "/v1/agreements", { buyer_ref: "b", seller_ref: "s", spec })
  ).body;
  const withInputs = inputs.length
    ? (await h.call(A(), "PUT", `/v1/agreements/${agr.id}/inputs`, { inputs })).body
    : agr;
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInputs.spec_hash,
  });
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
  return agr.id as string;
}

async function humanDecision(id: string, outcome = { kind: "release" }) {
  await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
    artifacts: [{ name: "out.txt", media_type: "text/plain", content: "done" }],
  });
  await h.call(O(), "POST", `/v1/ops/agreements/${id}/start-verification`);
  const res = await h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, {
    outcome,
    reason: "reviewed",
  });
  expect(res.status).toBe(200);
}

async function accountIdOf(name: string) {
  const [row] = await h.handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.name, name));
  return row?.id as string;
}

describe("usage events", () => {
  it("bills each verification run once, at its vertical's price (test mode isn't invoiced)", async () => {
    await setup();
    const spec = specFixture({
      vertical: "code",
      criteria: [
        { id: "tests-pass", description: "Tests pass", check: "deterministic", critical: true },
      ],
    });
    const id = await funded(spec, [
      {
        name: "t/a.test.mjs",
        media_type: "text/javascript",
        content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[tests-pass] f", () => { if (f() !== 1) throw new Error("no"); });\n`,
      },
    ]);
    await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
      artifacts: [
        { name: "f.mjs", media_type: "text/javascript", content: "export const f = () => 1;" },
      ],
    });
    expect((await h.call(O(), "POST", `/v1/ops/agreements/${id}/verify`)).status).toBe(200);

    const usage = (await h.call(A(), "GET", "/v1/billing/usage?period=2026-10")).body;
    expect(usage.test.verification_fees).toBe(300);
    expect(usage.live.verification_fees).toBe(0);
    expect(usage.events).toEqual([
      expect.objectContaining({
        kind: "verification",
        agreement_id: id,
        amount: 300,
        livemode: false,
      }),
    ]);
    // Other platforms don't see it.
    const other = (await h.call(h.keys.platformB, "GET", "/v1/billing/usage?period=2026-10")).body;
    expect(other.events).toEqual([]);
  });

  it("bills a dispute resolution at the higher of $25 or 5% of the amount", async () => {
    await setup();
    for (const value of [18_000, 100_000]) {
      const id = await funded(specFixture({ amount: { value, currency: "usd" } }));
      await humanDecision(id, { kind: "release" });
      await h.call(A(), "POST", `/v1/agreements/${id}/disputes`, {
        opened_by: "buyer",
        reason: "wrong",
      });
      const res = await h.call(O(), "POST", `/v1/ops/agreements/${id}/resolve-dispute`, {
        outcome: { kind: "refund" },
        reason: "seller at fault",
      });
      expect(res.status).toBe(200);
    }
    const events = (await h.call(A(), "GET", "/v1/billing/usage?period=2026-10")).body.events;
    expect(events.map((e: { amount: number }) => e.amount).sort()).toEqual([2_500, 5_000]);
    expect(events[0].description).toContain("losing party: seller");
  });

  it("rejects malformed periods", async () => {
    await setup();
    expect((await h.call(A(), "GET", "/v1/billing/usage?period=2026-13")).status).toBe(400);
  });
});

describe("monthly invoices", () => {
  async function liveEvents(accountId: string, amounts: [string, number][]) {
    for (const [kind, amount] of amounts) {
      await h.handle.db.insert(schema.billingEvents).values({
        id: newId("billingEvent"),
        accountId,
        kind: kind as "verification" | "dispute",
        ref: newId("verification"),
        livemode: true,
        amount,
        description:
          kind === "dispute"
            ? "Dispute resolution, agr_x (losing party: buyer)"
            : "Verification: translation",
        period: "2026-10",
        occurredAt: new Date("2026-10-15T00:00:00Z"),
      });
    }
  }

  it("invoices live usage once per account per closed month, grouped into lines", async () => {
    await setup();
    const live = await accountIdOf("Live Platform");
    await liveEvents(live, [
      ["verification", 150],
      ["verification", 150],
      ["verification", 150],
      ["dispute", 2_500],
    ]);
    const run = () => h.call(O(), "POST", "/v1/ops/billing/invoice", { period: "2026-10" });

    expect((await run()).body.error.code).toBe("period_open");
    h.clock.now = NOV;
    const noEmail = (await run()).body;
    expect(noEmail.skipped).toEqual([{ account_id: live, reason: "no billing email" }]);

    await h.call(h.keys.live, "PUT", "/v1/billing/settings", { email: "billing@live.example" });
    const first = (await run()).body;
    expect(first.invoiced).toEqual([expect.objectContaining({ account_id: live, total: 2_950 })]);
    expect(gw.invoices).toHaveLength(1);
    expect(gw.invoices[0]?.lines).toEqual([
      { description: "Verification: translation × 3 @ $1.50", amount: 450 },
      { description: "Dispute resolution, agr_x (losing party: buyer)", amount: 2_500 },
    ]);
    expect([...gw.customers.values()][0]).toMatchObject({ email: "billing@live.example" });

    const again = (await run()).body;
    expect(again.invoiced).toEqual([]);
    expect(gw.invoices).toHaveLength(1);

    const invoices = (await h.call(h.keys.live, "GET", "/v1/billing/invoices")).body.data;
    expect(invoices).toEqual([
      expect.objectContaining({
        period: "2026-10",
        status: "open",
        total: { value: 2_950, currency: "usd" },
      }),
    ]);
    const usage = (await h.call(h.keys.live, "GET", "/v1/billing/usage?period=2026-10")).body;
    expect(
      usage.events.every((e: { invoice_id: string | null }) => e.invoice_id === invoices[0].id),
    ).toBe(true);
    const ledger = (await h.call(O(), "GET", "/v1/ops/ledger/verify")).body;
    expect(ledger.ok).toBe(true);
  });

  it("tops verify-only accounts up to the $99 monthly minimum", async () => {
    await setup();
    const live = await accountIdOf("Live Platform");
    await h.call(O(), "PUT", `/v1/ops/accounts/${live}/plan`, { plan: "verify_only" });
    await h.call(h.keys.live, "PUT", "/v1/billing/settings", { email: "billing@live.example" });
    await liveEvents(live, [["verification", 150]]);
    h.clock.now = NOV;
    const res = (await h.call(O(), "POST", "/v1/ops/billing/invoice", { period: "2026-10" })).body;
    expect(res.invoiced[0].total).toBe(9_900);
    expect(gw.invoices[0]?.lines.at(-1)).toEqual({
      description: "Verify plan monthly minimum (top-up)",
      amount: 9_750,
    });
  });
});

describe("reviewer payouts", () => {
  it("pays each reviewer per decision once their payout account is ready", async () => {
    await setup();
    await humanDecision(await funded());
    await humanDecision(await funded(), { kind: "refund" });
    h.clock.now = NOV;
    const run = () =>
      h.call(O(), "POST", "/v1/ops/billing/reviewer-payouts", { period: "2026-10" });

    const notReady = (await run()).body;
    expect(notReady.failed).toEqual([
      expect.objectContaining({ amount: 1_600, error: expect.stringContaining("onboard") }),
    ]);

    const onboard = await h.call(O(), "POST", "/v1/ops/reviewers/me/onboarding", {
      email: "reviewer@proofdesk.example",
    });
    expect(onboard.status).toBe(201);
    gw.completeOnboarding(onboard.body.payout_account.stripe_account_id);

    const paid = (await run()).body;
    expect(paid.paid).toEqual([expect.objectContaining({ amount: 1_600 })]);
    expect(gw.payouts).toEqual([
      expect.objectContaining({
        amount: 1_600,
        destination: onboard.body.payout_account.stripe_account_id,
      }),
    ]);
    expect((await run()).body.skipped).toEqual([
      expect.objectContaining({ reason: "already paid" }),
    ]);
    expect(gw.payouts).toHaveLength(1);
  });

  it("is ops-only", async () => {
    await setup();
    h.clock.advance(40 * 24 * HOUR);
    const res = await h.call(A(), "POST", "/v1/ops/billing/reviewer-payouts", {
      period: "2026-10",
    });
    expect(res.status).toBe(403);
  });
});
