import { hashValue } from "@proofdesk/core";
import { z } from "zod";

/**
 * AP2 (Agent Payments Protocol) mandate import, parsing stub.
 *
 * An AP2 mandate is the user's signed record of what they asked for: an Intent Mandate
 * (natural-language task, before a cart exists) or a Cart Mandate (merchant-signed cart the
 * user approved). We use it as the source of "what was asked" when drafting criteria.
 *
 * NOT YET: signature verification (user credential / merchant_authorization JWT). Until then
 * every import is recorded as `signature_verified: false`, and the buyer still approves the
 * drafted spec by hash, as for any other draft.
 * Field names follow the AP2 reference types (ap2/types/mandate.py, W3C PaymentRequest).
 */

const IsoDateTime = z.iso.datetime({ offset: true });

export const IntentMandateSchema = z.object({
  natural_language_description: z.string().min(1).max(20_000),
  user_cart_confirmation_required: z.boolean().default(true),
  merchants: z.array(z.string()).nullish(),
  skus: z.array(z.string()).nullish(),
  requires_refundable_availability: z.boolean().default(false),
  intent_expiry: IsoDateTime,
});

const PaymentItemSchema = z.object({
  label: z.string(),
  amount: z.object({ currency: z.string().min(3).max(10), value: z.number().nonnegative() }),
});

export const CartMandateSchema = z.object({
  contents: z.object({
    id: z.string().min(1),
    user_cart_confirmation_required: z.boolean().default(true),
    payment_request: z.object({
      details: z.object({
        id: z.string().optional(),
        display_items: z.array(PaymentItemSchema).default([]),
        total: PaymentItemSchema,
      }),
    }),
    cart_expiry: IsoDateTime,
    merchant_name: z.string().min(1),
  }),
  merchant_authorization: z.string().nullish(),
});

export type MandateType = "intent" | "cart";

export interface ImportedMandate {
  type: MandateType;
  /** Hash of the mandate as received, recorded on the ledger. */
  mandate_hash: string;
  /** Text handed to the drafter as the buyer's request. */
  request: string;
  /** Cart total in minor units; intent mandates carry no price. */
  amount: { value: number; currency: string } | null;
  expires_at: string;
  signature_verified: false;
}

export class MandateError extends Error {
  constructor(
    readonly code: "invalid_mandate" | "mandate_expired",
    message: string,
  ) {
    super(message);
    this.name = "MandateError";
  }
}

/** Minor-unit digits per currency: ISO 4217 via Intl, plus stablecoins. */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (code === "USDC" || code === "USDT") return 6;
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    throw new MandateError("invalid_mandate", `unknown currency "${currency}"`);
  }
}

export function toMinorUnits(value: number, currency: string): number {
  return Math.round(value * 10 ** currencyDigits(currency));
}

export function importMandate(type: MandateType, raw: unknown, now: Date): ImportedMandate {
  const parsed = (type === "intent" ? IntentMandateSchema : CartMandateSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MandateError(
      "invalid_mandate",
      `not a valid AP2 ${type} mandate: ${issue?.path.join(".")} ${issue?.message}`,
    );
  }
  const mandate_hash = hashValue(raw);

  if (type === "intent") {
    const m = parsed.data as z.infer<typeof IntentMandateSchema>;
    assertNotExpired(m.intent_expiry, now);
    const extras = [
      m.merchants?.length ? `Merchants: ${m.merchants.join(", ")}.` : "",
      m.skus?.length ? `SKUs: ${m.skus.join(", ")}.` : "",
      m.requires_refundable_availability ? "Must be refundable." : "",
    ].filter(Boolean);
    return {
      type,
      mandate_hash,
      request: [m.natural_language_description, ...extras].join("\n"),
      amount: null,
      expires_at: new Date(m.intent_expiry).toISOString(),
      signature_verified: false,
    };
  }

  const { contents } = parsed.data as z.infer<typeof CartMandateSchema>;
  assertNotExpired(contents.cart_expiry, now);
  const { total, display_items } = contents.payment_request.details;
  const items = display_items.map(
    (i) => `- ${i.label} (${i.amount.value} ${i.amount.currency.toUpperCase()})`,
  );
  return {
    type,
    mandate_hash,
    request: [
      `Purchase from ${contents.merchant_name} (cart ${contents.id}).`,
      ...(items.length ? ["Items:", ...items] : []),
      `Total: ${total.amount.value} ${total.amount.currency.toUpperCase()}.`,
    ].join("\n"),
    amount: {
      value: toMinorUnits(total.amount.value, total.amount.currency),
      currency: total.amount.currency.toLowerCase(),
    },
    expires_at: new Date(contents.cart_expiry).toISOString(),
    signature_verified: false,
  };
}

function assertNotExpired(expiry: string, now: Date) {
  if (new Date(expiry).getTime() <= now.getTime()) {
    throw new MandateError("mandate_expired", `the mandate expired at ${expiry}`);
  }
}
