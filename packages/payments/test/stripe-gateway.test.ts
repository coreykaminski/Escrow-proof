import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeGateway } from "../src/stripe-gateway.ts";

/** A Stripe client whose paymentIntents.create is scripted per call; records params and keys. */
function scriptedStripe(responses: (Error | Record<string, unknown>)[]) {
  const calls: { params: Record<string, unknown>; idempotencyKey?: string }[] = [];
  const stripe = {
    paymentIntents: {
      create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        calls.push({ params, idempotencyKey: opts?.idempotencyKey });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

const pi = {
  id: "pi_1",
  status: "requires_capture",
  amount: 18_000,
  currency: "usd",
  amount_capturable: 18_000,
  amount_received: 0,
  latest_charge: {
    id: "ch_1",
    payment_method_details: { card: { capture_before: 1_800_000_000 } },
  },
  client_secret: "pi_1_secret",
  cancellation_reason: null,
  livemode: false,
  metadata: {},
};

const ineligible = () =>
  new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "payment_intent_invalid_parameter",
    message:
      "This account is not eligible for the requested card features. See https://stripe.com/docs/payments/flexible-payments for more details.",
  });

const hold = (gw: StripeGateway, key: string) =>
  gw.createHold({
    amount: 18_000,
    currency: "usd",
    agreementId: "agr_1",
    description: "test",
    paymentMethod: "pm_card_visa",
    extendedAuthorization: true,
    idempotencyKey: key,
  });

describe("StripeGateway extended authorization", () => {
  it("falls back to a standard hold when the account isn't eligible, then stops asking", async () => {
    const { stripe, calls } = scriptedStripe([ineligible(), pi, pi]);
    const gw = new StripeGateway({ secretKey: "sk_test_x", stripe });
    const h = await hold(gw, "hold:agr_1");
    expect(h).toMatchObject({ id: "pi_1", status: "requires_capture", extended: false });
    expect(calls.map((c) => c.idempotencyKey)).toEqual(["hold:agr_1", "hold:agr_1:standard"]);
    expect(calls[0]?.params.payment_method_options).toBeDefined();
    expect(calls[1]?.params.payment_method_options).toBeUndefined();

    await hold(gw, "hold:agr_2");
    expect(calls[2]?.params.payment_method_options).toBeUndefined();
  });

  it("doesn't swallow other errors", async () => {
    const declined = new Stripe.errors.StripeCardError({
      type: "card_error",
      code: "card_declined",
      message: "Your card was declined.",
    });
    const { stripe } = scriptedStripe([declined]);
    await expect(hold(new StripeGateway({ secretKey: "sk_test_x", stripe }), "k")).rejects.toThrow(
      /declined/,
    );
  });
});
