import { describe, expect, it } from "vitest";
import { currencyDigits, importMandate, MandateError, toMinorUnits } from "../src/ap2.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

const intent = {
  natural_language_description: "Translate my 12-page lease into French by Friday",
  user_cart_confirmation_required: true,
  merchants: ["LinguaBot"],
  skus: null,
  requires_refundable_availability: true,
  intent_expiry: "2026-10-07T12:00:00Z",
};

const cart = {
  contents: {
    id: "cart_42",
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [{ supported_methods: "CARD" }],
      details: {
        id: "order_42",
        display_items: [
          { label: "Lease translation EN→FR", amount: { currency: "USD", value: 179.99 } },
        ],
        total: { label: "Total", amount: { currency: "USD", value: 179.99 } },
      },
    },
    cart_expiry: "2026-10-06T18:00:00Z",
    merchant_name: "LinguaBot",
  },
  merchant_authorization: "eyJhbGciOi...",
};

describe("importMandate", () => {
  it("turns an intent mandate into a request without a price", () => {
    const m = importMandate("intent", intent, NOW);
    expect(m).toMatchObject({
      type: "intent",
      amount: null,
      expires_at: "2026-10-07T12:00:00.000Z",
      signature_verified: false,
    });
    expect(m.request).toContain("Translate my 12-page lease into French");
    expect(m.request).toContain("Merchants: LinguaBot.");
    expect(m.request).toContain("Must be refundable.");
    expect(m.mandate_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes the amount from a cart mandate's total, in minor units", () => {
    const m = importMandate("cart", cart, NOW);
    expect(m.amount).toEqual({ value: 17_999, currency: "usd" });
    expect(m.request).toContain("Purchase from LinguaBot (cart cart_42)");
    expect(m.request).toContain("- Lease translation EN→FR (179.99 USD)");
  });

  it("hashes the mandate as received, so any change is detectable", () => {
    const a = importMandate("intent", intent, NOW).mandate_hash;
    const b = importMandate("intent", { ...intent, merchants: ["Other"] }, NOW).mandate_hash;
    expect(a).not.toBe(b);
  });

  it("rejects expired mandates", () => {
    const later = new Date("2026-10-08T00:00:00Z");
    expect(() => importMandate("intent", intent, later)).toThrow(/expired/);
    try {
      importMandate("cart", cart, later);
    } catch (err) {
      expect((err as MandateError).code).toBe("mandate_expired");
    }
  });

  it("rejects malformed mandates with the failing field", () => {
    expect(() => importMandate("intent", { intent_expiry: "2026-10-07T12:00:00Z" }, NOW)).toThrow(
      /natural_language_description/,
    );
    expect(() => importMandate("cart", intent, NOW)).toThrow(MandateError);
  });
});

describe("currency minor units", () => {
  it.each([
    ["usd", 2],
    ["JPY", 0],
    ["kwd", 3],
    ["usdc", 6],
  ])("%s has %i digits", (c, d) => {
    expect(currencyDigits(c)).toBe(d);
  });

  it("rounds float amounts instead of truncating", () => {
    expect(toMinorUnits(0.29, "usd")).toBe(29);
    expect(toMinorUnits(1500, "jpy")).toBe(1500);
  });

  it("rejects unknown currencies", () => {
    expect(() => currencyDigits("notacurrency")).toThrow(MandateError);
  });
});
