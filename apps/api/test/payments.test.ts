/**
 * Card rail payment scenarios (MASTER_PLAN §8 test layer 4) against FakeGateway, which mimics
 * Stripe: holds that lapse, partial capture, idempotency keys, signed webhooks.
 */
import { FakeGateway } from "@proofdesk/payments";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

const DAY = 24 * HOUR;
let h: Harness;
let gw: FakeGateway;

afterEach(async () => {
  await h?.close();
});

async function setup() {
  h = await createHarness({
    payments: (now) => {
      gw = new FakeGateway({ now, webhookSecret: "whsec_test" });
      return gw;
    },
  });
}

const A = () => h.keys.platformA;
const O = () => h.keys.ops;

/** Seller onboarded (or not), agreement approved; returns the agreement id. */
async function approved(
  opts: { onboard?: boolean; spec?: Record<string, unknown>; seller?: string } = {},
) {
  const seller = opts.seller ?? "agent_translator_7";
  const onboarding = await h.call(A(), "POST", `/v1/sellers/${seller}/onboarding`, {
    email: "seller@example.com",
  });
  expect(onboarding.status).toBe(201);
  if (opts.onboard !== false) gw.completeOnboarding(onboarding.body.seller.stripe_account_id);
  const agr = (
    await h.call(A(), "POST", "/v1/agreements", {
      buyer_ref: "user_buyer_1",
      seller_ref: seller,
      spec: opts.spec ?? specFixture(),
    })
  ).body;
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  return agr.id as string;
}

async function fundWithCard(id: string, paymentMethod = "pm_card_visa") {
  const res = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
    payment_method: paymentMethod,
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** Funded → delivered → decided with the given outcome (by ops). */
async function decided(id: string, outcome: Record<string, unknown>) {
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

const settle = (id: string, body: Record<string, unknown> = {}) =>
  h.call(O(), "POST", `/v1/ops/agreements/${id}/settle`, body);

const ledgerTypes = async (id: string) =>
  (await h.call(A(), "GET", `/v1/agreements/${id}/ledger`)).body.data.map(
    (e: { type: string }) => e.type,
  );

describe("sellers", () => {
  it("creates one payout account per seller and reports onboarding status", async () => {
    await setup();
    const first = await h.call(A(), "POST", "/v1/sellers/s1/onboarding", {
      email: "seller@example.com",
    });
    expect(first.body).toMatchObject({
      seller: { seller_ref: "s1", payouts_ready: false },
      onboarding_url: expect.stringContaining(first.body.seller.stripe_account_id),
    });
    const again = await h.call(A(), "POST", "/v1/sellers/s1/onboarding", {
      email: "seller@example.com",
    });
    expect(again.body.seller.stripe_account_id).toBe(first.body.seller.stripe_account_id);
    gw.completeOnboarding(first.body.seller.stripe_account_id);
    expect((await h.call(A(), "GET", "/v1/sellers/s1")).body.payouts_ready).toBe(true);
    expect((await h.call(h.keys.platformB, "GET", "/v1/sellers/s1")).status).toBe(404);
  });
});

describe("funding with a card hold", () => {
  it("authorizes the card and funds the agreement, asking for extended auth on long jobs", async () => {
    await setup();
    const id = await approved();
    const body = await fundWithCard(id);
    expect(body.agreement).toMatchObject({
      status: "funded",
      hold: { rail: "card", ref: body.hold.payment_intent_id },
    });
    expect(body.hold).toMatchObject({
      status: "authorized",
      amount: { value: 18_000, currency: "usd" },
      extended_authorization: true,
    });
    expect(await ledgerTypes(id)).toEqual(
      expect.arrayContaining(["hold.created", "agreement.fund"]),
    );
  });

  it("funds with an agent's shared payment token (MPP/ACP) that covers the amount", async () => {
    await setup();
    const id = await approved();
    const spt = gw.grantSharedPaymentToken({ currency: "usd", maxAmount: 18_000 });
    const res = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
      shared_payment_token: spt,
    });
    expect(res.status).toBe(201);
    expect(res.body.agreement.status).toBe("funded");
    expect(res.body.payment_intent_status).toBe("requires_capture");
    // The token is spent: it can't fund another hold.
    expect((await gw.getSharedPaymentToken(spt)).active).toBe(false);
  });

  it("refuses shared payment tokens that don't cover this hold, before charging", async () => {
    await setup();
    const id = await approved();
    const cases = [
      [gw.grantSharedPaymentToken({ currency: "usd", maxAmount: 17_999 }), "limit"],
      [gw.grantSharedPaymentToken({ currency: "eur", maxAmount: 50_000 }), "EUR"],
      [
        gw.grantSharedPaymentToken({
          currency: "usd",
          maxAmount: 50_000,
          expiresAt: new Date(h.clock.now.getTime() - 1000),
        }),
        "expired",
      ],
      ["spt_doesnotexist", "No such"],
    ] as const;
    for (const [spt, why] of cases) {
      const res = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
        shared_payment_token: spt,
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("shared_payment_token_rejected");
      expect(res.body.error.message).toContain(why);
    }
    expect(gw.holds.size).toBe(0);
    const both = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
      payment_method: "pm_card_visa",
      shared_payment_token: "spt_x",
    });
    expect(both.status).toBe(400);
  });

  it("funds via webhook when the buyer confirms on the client, and handles replays", async () => {
    await setup();
    const id = await approved();
    const created = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {});
    expect(created.body).toMatchObject({
      payment_intent_status: "requires_payment_method",
      agreement: { status: "spec_approved" },
    });
    expect(created.body.client_secret).toMatch(/_secret$/);

    const pi = created.body.hold.payment_intent_id;
    gw.confirm(pi);
    const delivery = gw.webhook("payment_intent.amount_capturable_updated", pi);
    const post = () =>
      h.call(null, "POST", "/webhooks/stripe", delivery.body, {
        "Stripe-Signature": delivery.signature,
      });
    expect((await post()).body).toMatchObject({ received: true, status: "processed" });
    expect((await post()).body.status).toBe("duplicate");
    // A different, late event for the same payment intent re-syncs harmlessly.
    const late = gw.webhook("payment_intent.created", pi);
    await h.call(null, "POST", "/webhooks/stripe", late.body, {
      "Stripe-Signature": late.signature,
    });

    const agr = await h.call(A(), "GET", `/v1/agreements/${id}`);
    expect(agr.body.status).toBe("funded");
    expect((await ledgerTypes(id)).filter((t: string) => t === "agreement.fund")).toHaveLength(1);
  });

  it("rejects forged webhooks", async () => {
    await setup();
    const fake = gw.webhook("payment_intent.succeeded", "pi_x");
    const res = await h.call(null, "POST", "/webhooks/stripe", fake.body, {
      "Stripe-Signature": "fake=nope",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_signature");
  });

  it("returns the existing hold on repeat calls instead of creating another", async () => {
    await setup();
    const id = await approved();
    const a = await fundWithCard(id);
    const b = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
      payment_method: "pm_card_visa",
    });
    expect(b.body.hold.id).toBe(a.hold.id);
    expect(gw.log.filter((l) => l.startsWith("hold.create"))).toHaveLength(1);
  });

  it("refuses declined cards, sellers without a payout account, and live/test mixups", async () => {
    await setup();
    const id = await approved();
    const declined = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {
      payment_method: "pm_card_chargeDeclined",
    });
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe("card_declined");

    const agr = (
      await h.call(A(), "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "nobody",
        spec: specFixture(),
      })
    ).body;
    await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    const noSeller = await h.call(A(), "POST", `/v1/agreements/${agr.id}/card-hold`, {
      payment_method: "pm_card_visa",
    });
    expect(noSeller.body.error.code).toBe("seller_not_onboarded");

    const live = (
      await h.call(h.keys.live, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture(),
      })
    ).body;
    const mixed = await h.call(h.keys.live, "POST", `/v1/agreements/${live.id}/card-hold`, {});
    expect(mixed.body.error.code).toBe("livemode_mismatch");
  });

  it("releases the authorization if the buyer confirms after the delivery deadline", async () => {
    await setup();
    const id = await approved();
    const created = await h.call(A(), "POST", `/v1/agreements/${id}/card-hold`, {});
    h.clock.advance(5 * DAY); // past 2026-10-10
    const pi = created.body.hold.payment_intent_id;
    gw.confirm(pi);
    const e = gw.webhook("payment_intent.amount_capturable_updated", pi);
    await h.call(null, "POST", "/webhooks/stripe", e.body, { "Stripe-Signature": e.signature });
    expect((await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body.status).toBe("canceled");
    expect((await h.call(A(), "GET", `/v1/agreements/${id}`)).body.status).toBe("spec_approved");
  });
});

describe("settlement", () => {
  it("release: captures the hold and pays the seller minus the 2% fee", async () => {
    await setup();
    const id = await approved();
    await fundWithCard(id);
    await decided(id, { kind: "release" });

    const early = await settle(id);
    expect(early.body.error.code).toBe("appeal_window_open");
    expect(gw.log.some((l) => l.startsWith("hold.capture"))).toBe(false);

    h.clock.advance(72 * HOUR);
    const res = await settle(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "settled",
      settlement_ref: expect.stringMatching(/^tr_/),
    });
    expect(gw.transfers).toEqual([expect.objectContaining({ amount: 17_640, agreementId: id })]);
    const hold = (await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body;
    expect(hold).toMatchObject({
      status: "settled",
      captured_amount: 18_000,
      settlement: { release: 18_000, fee: 360, seller_payout: 17_640, buyer_refund: 0 },
    });
    expect((await ledgerTypes(id)).slice(-2)).toEqual(["hold.settled", "agreement.settle"]);
  });

  it("refund: cancels the authorization, so nothing is charged and no fee applies", async () => {
    await setup();
    const id = await approved();
    const { hold } = await fundWithCard(id);
    await decided(id, { kind: "refund" });
    h.clock.advance(72 * HOUR);
    expect((await settle(id)).body.status).toBe("settled");
    expect(gw.holds.get(hold.payment_intent_id)).toMatchObject({
      status: "canceled",
      amount_received: 0,
    });
    expect(gw.transfers).toEqual([]);
  });

  it("partial: captures only the released share", async () => {
    await setup();
    const id = await approved();
    const { hold } = await fundWithCard(id);
    await decided(id, { kind: "partial", release_percent: 40 });
    h.clock.advance(72 * HOUR);
    await settle(id);
    expect(gw.holds.get(hold.payment_intent_id)?.amount_received).toBe(7_200);
    expect(gw.transfers[0]?.amount).toBe(7_200 - 144);
  });

  it("never moves money twice: repeat settles and retries after a failed transfer", async () => {
    await setup();
    const id = await approved({ onboard: false });
    await fundWithCard(id);
    await decided(id, { kind: "release" });
    h.clock.advance(72 * HOUR);

    // The seller hasn't finished onboarding: refused before any money moves.
    const blocked = await settle(id);
    expect(blocked.body.error.code).toBe("seller_not_ready");
    expect(gw.log.filter((l) => l.startsWith("hold.capture"))).toHaveLength(0);

    const seller = (await h.call(A(), "GET", "/v1/sellers/agent_translator_7")).body;
    gw.completeOnboarding(seller.stripe_account_id);
    // Simulate a crash after capture: the capture happened, then the transfer never ran.
    const { payment_intent_id } = (await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body;
    await gw.capture(payment_intent_id, 18_000, `settle:${id}:capture`);

    expect((await settle(id)).body.status).toBe("settled");
    expect((await settle(id)).body.error.code).toBe("invalid_transition");
    expect(gw.log.filter((l) => l.startsWith("hold.capture"))).toHaveLength(1);
    expect(gw.transfers).toHaveLength(1);
  });

  it("blocks payout while a chargeback is open", async () => {
    await setup();
    const id = await approved();
    const { hold } = await fundWithCard(id);
    await decided(id, { kind: "release" });
    const e = gw.webhook("charge.dispute.created", "dp_1", hold.payment_intent_id);
    await h.call(null, "POST", "/webhooks/stripe", e.body, { "Stripe-Signature": e.signature });
    h.clock.advance(72 * HOUR);
    expect((await settle(id)).body.error.code).toBe("hold_disputed");
    expect(await ledgerTypes(id)).toContain("hold.chargeback_opened");
  });
});

describe("auth expiry", () => {
  it("captures a hold before it lapses, then still settles a release from the captured funds", async () => {
    await setup();
    // Extended authorization is requested but the issuer refuses it: the 7-day window applies.
    const id = await approved({
      spec: specFixture({ delivery_due_at: "2026-10-07T12:00:00Z", appeal_window_hours: 200 }),
    });
    const { hold } = await fundWithCard(id, "pm_card_noExtended");
    expect(hold.extended_authorization).toBe(false);
    await decided(id, { kind: "release" });

    h.clock.advance(6 * DAY + 1 * HOUR); // within 24h of the 7-day lapse, appeal window still open
    const tick = (await h.call(O(), "POST", "/v1/ops/run-due")).body;
    expect(tick.captured_early).toEqual([id]);
    expect((await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body.status).toBe("captured");

    h.clock.advance(3 * DAY); // authorization would have lapsed by now; appeal window closed
    const later = (await h.call(O(), "POST", "/v1/ops/run-due")).body;
    expect(later.settled).toEqual([id]);
    expect(gw.transfers[0]?.amount).toBe(17_640);
    expect(await ledgerTypes(id)).toContain("hold.captured");
  });

  it("refunds captured-early funds when the decision is a refund", async () => {
    await setup();
    const id = await approved({
      spec: specFixture({ delivery_due_at: "2026-10-07T12:00:00Z", appeal_window_hours: 120 }),
    });
    await fundWithCard(id, "pm_card_noExtended");
    await decided(id, { kind: "refund" });
    h.clock.advance(6 * DAY + 1 * HOUR);
    await h.call(O(), "POST", "/v1/ops/run-due");
    h.clock.advance(2 * DAY);
    await h.call(O(), "POST", "/v1/ops/run-due");
    expect(gw.refunds).toEqual([expect.objectContaining({ amount: 18_000 })]);
    expect((await h.call(A(), "GET", `/v1/agreements/${id}`)).body.status).toBe("settled");
  });

  it("records a lapsed authorization and refuses to release from it", async () => {
    await setup();
    const id = await approved();
    const { hold } = await fundWithCard(id);
    await decided(id, { kind: "release" });
    gw.expire(hold.payment_intent_id);
    const e = gw.webhook("payment_intent.canceled", hold.payment_intent_id);
    await h.call(null, "POST", "/webhooks/stripe", e.body, { "Stripe-Signature": e.signature });
    expect((await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body.status).toBe("expired");
    expect(await ledgerTypes(id)).toContain("hold.expired");
    h.clock.advance(72 * HOUR);
    expect((await settle(id)).body.error.code).toBe("hold_unsettleable");
  });
});

describe("run-due", () => {
  it("refunds missed deadlines and settles test-rail agreements once their window closes", async () => {
    await setup();
    const id = await approved();
    await fundWithCard(id);
    h.clock.advance(5 * DAY); // past the delivery deadline
    const first = (await h.call(O(), "POST", "/v1/ops/run-due")).body;
    expect(first.deadlines_missed).toEqual([id]);
    h.clock.advance(72 * HOUR);
    const second = (await h.call(O(), "POST", "/v1/ops/run-due")).body;
    expect(second.settled).toContain(id);
    expect((await h.call(A(), "GET", `/v1/agreements/${id}/hold`)).body.status).toBe("settled");
  });

  it("still settles test-rail agreements without a card processor", async () => {
    h = await createHarness();
    const agr = (
      await h.call(A(), "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture(),
      })
    ).body;
    await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    await h.call(A(), "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
    await decided(agr.id, { kind: "release" });
    h.clock.advance(72 * HOUR);
    const tick = (await h.call(O(), "POST", "/v1/ops/run-due")).body;
    expect(tick.settled).toEqual([agr.id]);
  });
});
