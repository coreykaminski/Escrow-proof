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

  async createSellerAccount(p: { sellerRef: string; idempotencyKey: string }) {
    const account = await this.call(() =>
      this.stripe.accounts.create(
        {
          type: "express",
          capabilities: { transfers: { requested: true } },
          metadata: { seller_ref: p.sellerRef },
        },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return toSeller(account);
  }

  async getSellerAccount(id: string) {
    return toSeller(await this.call(() => this.stripe.accounts.retrieve(id)));
  }

  async createOnboardingLink(p: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.call(() =>
      this.stripe.accountLinks.create({
        account: p.accountId,
        refresh_url: p.refreshUrl,
        return_url: p.returnUrl,
        type: "account_onboarding",
      }),
    );
    return { url: link.url };
  }

  async createHold(p: Parameters<PaymentsGateway["createHold"]>[0]) {
    const pi = await this.call(() =>
      this.stripe.paymentIntents.create(
        {
          amount: p.amount,
          currency: p.currency,
          capture_method: "manual",
          allowed_payment_method_types: ["card"],
          description: p.description,
          transfer_group: p.agreementId,
          metadata: { agreement_id: p.agreementId },
          ...(p.extendedAuthorization
            ? {
                payment_method_options: {
                  card: { request_extended_authorization: "if_available" },
                },
              }
            : {}),
          ...(p.paymentMethod ? { payment_method: p.paymentMethod, confirm: true } : {}),
          expand: ["latest_charge"],
        },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return toHold(pi);
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

  async transfer(p: Parameters<PaymentsGateway["transfer"]>[0]) {
    const transfer = await this.call(() =>
      this.stripe.transfers.create(
        {
          amount: p.amount,
          currency: p.currency,
          destination: p.destination,
          transfer_group: p.agreementId,
          source_transaction: p.sourceCharge,
          metadata: { agreement_id: p.agreementId },
        },
        { idempotencyKey: p.idempotencyKey },
      ),
    );
    return { id: transfer.id };
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

function toSeller(a: Stripe.Account): SellerAccountState {
  return {
    id: a.id,
    details_submitted: a.details_submitted ?? false,
    transfers_active: a.capabilities?.transfers === "active",
    payouts_enabled: a.payouts_enabled ?? false,
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
