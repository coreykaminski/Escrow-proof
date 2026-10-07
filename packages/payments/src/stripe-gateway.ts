import Stripe from "stripe";
import {
  GatewayError,
  type GatewayEvent,
  type HoldState,
  type PaymentsGateway,
  type SellerAccountState,
  WebhookSignatureError,
} from "./gateway.ts";

/**
 * Stripe implementation: Connect Express sellers, PaymentIntents with manual capture as holds,
 * separate charges and transfers for payouts. Every mutating call carries an idempotency key.
 */
export class StripeGateway implements PaymentsGateway {
  readonly mode: "test" | "live";
  private readonly stripe: Stripe;

  constructor(
    private readonly opts: { secretKey: string; webhookSecret?: string; stripe?: Stripe },
  ) {
    this.mode =
      opts.secretKey.startsWith("sk_live_") || opts.secretKey.startsWith("rk_live_")
        ? "live"
        : "test";
    this.stripe = opts.stripe ?? new Stripe(opts.secretKey);
  }

  /**
   * Sellers are Accounts v2 with Stripe-hosted onboarding (Express dashboard). Stripe no longer
   * allows creating v1 accounts on new Connect platforms. Payouts need the recipient
   * `stripe_transfers` capability; for US sellers Stripe also requires `card_payments`.
   */
  async createSellerAccount(p: {
    sellerRef: string;
    country: string;
    email: string;
    idempotencyKey: string;
  }) {
    const account = await this.call(() =>
      this.stripe.v2.core.accounts.create(
        {
          dashboard: "express",
          contact_email: p.email,
          identity: { country: p.country.toLowerCase() },
          defaults: {
            responsibilities: { fees_collector: "application", losses_collector: "application" },
          },
          configuration: {
            merchant: { capabilities: { card_payments: { requested: true } } },
            recipient: {
              capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
            },
          },
          include: [...SELLER_INCLUDE],
          metadata: { seller_ref: p.sellerRef },
        },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return toSeller(account);
  }

  async getSellerAccount(id: string) {
    return toSeller(
      await this.call(() =>
        this.stripe.v2.core.accounts.retrieve(id, { include: [...SELLER_INCLUDE] }),
      ),
    );
  }

  async createOnboardingLink(p: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.call(() =>
      this.stripe.v2.core.accountLinks.create({
        account: p.accountId,
        use_case: {
          type: "account_onboarding",
          account_onboarding: { refresh_url: p.refreshUrl, return_url: p.returnUrl },
        },
      }),
    );
    return { url: link.url };
  }

  /** Set once Stripe says this account can't use extended authorization. */
  private extendedUnavailable = false;

  async createHold(p: Parameters<PaymentsGateway["createHold"]>[0]) {
    const create = (extended: boolean, idempotencyKey: string) =>
      this.stripe.paymentIntents.create(
        {
          amount: p.amount,
          currency: p.currency,
          capture_method: "manual",
          allowed_payment_method_types: ["card"],
          description: p.description,
          transfer_group: p.agreementId,
          metadata: { agreement_id: p.agreementId },
          ...(extended
            ? {
                payment_method_options: {
                  card: { request_extended_authorization: "if_available" },
                },
              }
            : {}),
          ...(p.paymentMethod ? { payment_method: p.paymentMethod, confirm: true } : {}),
          expand: ["latest_charge"],
        },
        { idempotencyKey },
      );

    const wantExtended = p.extendedAuthorization && !this.extendedUnavailable;
    try {
      return toHold(await this.call(() => create(wantExtended, p.idempotencyKey)));
    } catch (err) {
      // Accounts without extended-authorization access get a 400 for the whole request, not a
      // silently ignored option. Fall back to a standard hold; the scheduler captures holds
      // before they lapse, so long jobs still settle correctly.
      if (!wantExtended || !isExtendedAuthIneligible(err)) throw err;
      this.extendedUnavailable = true;
      return toHold(await this.call(() => create(false, `${p.idempotencyKey}:standard`)));
    }
  }

  async getHold(id: string) {
    return toHold(
      await this.call(() => this.stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] })),
    );
  }

  async capture(id: string, amount: number, idempotencyKey: string) {
    const pi = await this.call(() =>
      this.stripe.paymentIntents.capture(
        id,
        { amount_to_capture: amount, expand: ["latest_charge"] },
        { idempotencyKey },
      ),
    );
    return toHold(pi);
  }

  async cancel(id: string, idempotencyKey: string) {
    const pi = await this.call(() =>
      this.stripe.paymentIntents.cancel(id, { expand: ["latest_charge"] }, { idempotencyKey }),
    );
    return toHold(pi);
  }

  async refund(p: { holdId: string; amount: number; idempotencyKey: string }) {
    const refund = await this.call(() =>
      this.stripe.refunds.create(
        { payment_intent: p.holdId, amount: p.amount },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return { id: refund.id };
  }

  /**
   * Pays the seller from a captured charge. The transfer has to be in the currency the charge
   * settled in (a CAD platform settles USD charges in CAD), so the seller's share is converted
   * at the exact rate Stripe applied to that charge.
   */
  async transfer(p: Parameters<PaymentsGateway["transfer"]>[0]) {
    const charge = await this.call(() =>
      this.stripe.charges.retrieve(p.sourceCharge, { expand: ["balance_transaction"] }),
    );
    const bt = typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
    let amount = p.amount;
    let currency = p.currency;
    if (bt && bt.currency !== p.currency.toLowerCase()) {
      if (charge.amount_captured <= 0) throw new GatewayError("charge isn't captured", false);
      amount = Math.floor((p.amount * bt.amount) / charge.amount_captured);
      currency = bt.currency;
    }
    const transfer = await this.call(() =>
      this.stripe.transfers.create(
        {
          amount,
          currency,
          destination: p.destination,
          transfer_group: p.agreementId,
          source_transaction: p.sourceCharge,
          metadata: { agreement_id: p.agreementId, charge_currency_amount: String(p.amount) },
        },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return { id: transfer.id, amount: transfer.amount, currency: transfer.currency };
  }

  parseWebhook(rawBody: string, signature: string): GatewayEvent {
    if (!this.opts.webhookSecret) throw new WebhookSignatureError("webhook secret not configured");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret);
    } catch (err) {
      throw new WebhookSignatureError(err instanceof Error ? err.message : undefined);
    }
    const object = event.data.object as {
      id?: string;
      payment_intent?: string | { id: string } | null;
    };
    const pi = object.payment_intent;
    return {
      id: event.id,
      type: event.type,
      object_id: object.id ?? "",
      payment_intent_id: typeof pi === "string" ? pi : (pi?.id ?? null),
      livemode: event.livemode,
    };
  }

  /** Maps Stripe errors to GatewayError, marking which are safe to retry. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        const retryable =
          err instanceof Stripe.errors.StripeConnectionError ||
          err instanceof Stripe.errors.StripeRateLimitError ||
          err instanceof Stripe.errors.StripeAPIError ||
          (err.statusCode ?? 0) >= 500;
        throw new GatewayError(err.message, retryable, err.code, { cause: err });
      }
      throw err;
    }
  }
}

function isExtendedAuthIneligible(err: unknown): boolean {
  return (
    err instanceof GatewayError &&
    !err.retryable &&
    /not eligible for the requested card features|extended_authorization/i.test(err.message)
  );
}

const SELLER_INCLUDE = ["configuration.recipient", "requirements"] as const;

function toSeller(a: Stripe.V2.Core.Account): SellerAccountState {
  const balance = a.configuration?.recipient?.capabilities?.stripe_balance;
  const outstanding = (a.requirements?.entries ?? []).some((e) =>
    ["currently_due", "past_due"].includes(e.minimum_deadline?.status ?? ""),
  );
  return {
    id: a.id,
    details_submitted: !outstanding,
    transfers_active: balance?.stripe_transfers?.status === "active",
    payouts_enabled: balance?.payouts?.status === "active",
  };
}

function toHold(pi: Stripe.PaymentIntent): HoldState {
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card;
  return {
    id: pi.id,
    status: pi.status as HoldState["status"],
    amount: pi.amount,
    currency: pi.currency,
    amount_capturable: pi.amount_capturable,
    amount_received: pi.amount_received,
    capture_before: card?.capture_before ? new Date(card.capture_before * 1000) : null,
    extended: card?.extended_authorization?.status === "enabled",
    charge_id: charge?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : null),
    client_secret: pi.client_secret,
    cancellation_reason: pi.cancellation_reason,
    livemode: pi.livemode,
    metadata: pi.metadata,
  };
}
