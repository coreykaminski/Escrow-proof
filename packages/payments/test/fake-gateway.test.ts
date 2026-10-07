import { describe, expect, it } from "vitest";
import { FakeGateway } from "../src/fake-gateway.ts";
import { GatewayError, WebhookSignatureError } from "../src/gateway.ts";

const clock = { now: new Date("2026-10-07T00:00:00Z") };
const make = () => new FakeGateway({ now: () => clock.now, webhookSecret: "whsec_test" });
const hold = (gw: FakeGateway, over: Partial<Parameters<FakeGateway["createHold"]>[0]> = {}) =>
  gw.createHold({
    amount: 10_000,
    currency: "usd",
    agreementId: "agr_1",
    description: "test",
    paymentMethod: "pm_card_visa",
    extendedAuthorization: false,
    idempotencyKey: "hold:agr_1",
    ...over,
  });

describe("FakeGateway", () => {
  it("authorizes with a 7-day window, or 30 when extended is granted", async () => {
    const gw = make();
    const h = await hold(gw);
    expect(h).toMatchObject({
      status: "requires_capture",
      amount_capturable: 10_000,
      extended: false,
    });
    expect(h.capture_before?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    const ext = await hold(gw, { extendedAuthorization: true, idempotencyKey: "k2" });
    expect(ext.extended).toBe(true);
    const denied = await hold(gw, {
      extendedAuthorization: true,
      paymentMethod: "pm_card_noExtended",
      idempotencyKey: "k3",
    });
    expect(denied.extended).toBe(false);
  });

  it("replays idempotent requests and rejects a reused key with different params", async () => {
    const gw = make();
    const a = await hold(gw);
    const b = await hold(gw);
    expect(b.id).toBe(a.id);
    expect(gw.log.filter((l) => l.startsWith("hold.create"))).toHaveLength(1);
    await expect(hold(gw, { amount: 1 })).rejects.toThrow(GatewayError);
    await gw.capture(a.id, 10_000, "cap");
    await gw.capture(a.id, 10_000, "cap");
    expect(gw.log.filter((l) => l.startsWith("hold.capture"))).toHaveLength(1);
  });

  it("can't capture after the authorization lapses", async () => {
    const gw = make();
    const h = await hold(gw);
    clock.now = new Date("2026-10-15T00:00:00Z");
    await expect(gw.capture(h.id, 10_000, "late")).rejects.toThrow(/status canceled/);
    expect((await gw.getHold(h.id)).cancellation_reason).toBe("automatic");
    clock.now = new Date("2026-10-07T00:00:00Z");
  });

  it("only transfers to onboarded sellers from captured charges", async () => {
    const gw = make();
    const seller = await gw.createSellerAccount({ sellerRef: "s1", idempotencyKey: "acct:s1" });
    const h = await hold(gw);
    const t = (key: string) =>
      gw.transfer({
        amount: 9_800,
        currency: "usd",
        destination: seller.id,
        agreementId: "agr_1",
        sourceCharge: h.charge_id ?? "",
        idempotencyKey: key,
      });
    await expect(t("t1")).rejects.toThrow(/can't receive transfers/);
    gw.completeOnboarding(seller.id);
    await expect(t("t2")).rejects.toThrow(/isn't captured/);
    await gw.capture(h.id, 10_000, "cap");
    await expect(t("t3")).resolves.toMatchObject({ id: expect.stringMatching(/^tr_/) });
  });

  it("verifies webhook signatures", () => {
    const gw = make();
    const { body, signature } = gw.webhook("payment_intent.canceled", "pi_1");
    expect(gw.parseWebhook(body, signature)).toMatchObject({
      type: "payment_intent.canceled",
      object_id: "pi_1",
    });
    expect(() => gw.parseWebhook(body.replace("pi_1", "pi_2"), signature)).toThrow(
      WebhookSignatureError,
    );
  });

  it("declines the decline test card", async () => {
    await expect(hold(make(), { paymentMethod: "pm_card_chargeDeclined" })).rejects.toThrow(
      /declined/,
    );
  });
});
