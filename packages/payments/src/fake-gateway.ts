import { createHash } from "node:crypto";
import {
  GatewayError,
  type GatewayEvent,
  type HoldState,
  type PaymentsGateway,
  type SellerAccountState,
  type SharedPaymentToken,
  WebhookSignatureError,
} from "./gateway.ts";
import { AUTH_WINDOW_DAYS } from "./settlement.ts";

const DAY = 86_400_000;

/**
 * In-memory stand-in for Stripe with the semantics the settlement logic depends on:
 * authorization windows that expire, partial capture, cancel-vs-refund, transfers that need an
 * onboarded seller, idempotency keys (same key → same result, different request → error), and
 * signed webhooks. Test card ids mirror Stripe's: pm_card_visa succeeds, pm_card_chargeDeclined
 * declines, pm_card_noExtended is never granted extended authorization.
 */
export class FakeGateway implements PaymentsGateway {
  readonly mode: "test" | "live";
  readonly holds = new Map<string, HoldState & { refunded: number }>();
  readonly accounts = new Map<string, SellerAccountState>();
  readonly transfers: { id: string; amount: number; destination: string; agreementId: string }[] =
    [];
  readonly refunds: { id: string; holdId: string; amount: number }[] = [];
  /** Shared payment tokens "granted" to us, with the payment method behind each. */
  readonly sharedTokens = new Map<string, SharedPaymentToken & { paymentMethod: string }>();
  /** Every mutating call that reached the "processor" (idempotent replays aren't counted). */
  readonly log: string[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private seq = 0;

  constructor(
    private readonly opts: { now: () => Date; webhookSecret?: string; mode?: "test" | "live" },
  ) {
    this.mode = opts.mode ?? "test";
  }

  private id(prefix: string) {
    return `${prefix}_fake${String(++this.seq).padStart(6, "0")}`;
  }

  private once<T>(key: string, request: unknown, fn: () => T): T {
    const fingerprint = JSON.stringify(request);
    const seen = this.idempotency.get(key);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new GatewayError(
          "idempotency key reused with different parameters",
          false,
          "idempotency_error",
        );
      }
      return structuredClone(seen.result) as T;
    }
    const result = fn();
    this.idempotency.set(key, { fingerprint, result: structuredClone(result) });
    return result;
  }

  async createSellerAccount(p: {
    sellerRef: string;
    country: string;
    email: string;
    idempotencyKey: string;
  }) {
    return this.once(p.idempotencyKey, ["account", p.sellerRef], () => {
      this.log.push(`account.create ${p.sellerRef}`);
      const account = {
        id: this.id("acct"),
        details_submitted: false,
        transfers_active: false,
        payouts_enabled: false,
      };
      this.accounts.set(account.id, account);
      return { ...account };
    });
  }

  /** Simulates the seller finishing Stripe's hosted onboarding. */
  completeOnboarding(id: string) {
    const a = this.mustAccount(id);
    Object.assign(a, { details_submitted: true, transfers_active: true, payouts_enabled: true });
  }

  async getSellerAccount(id: string) {
    return { ...this.mustAccount(id) };
  }

  async createOnboardingLink(p: { accountId: string; refreshUrl: string; returnUrl: string }) {
    this.mustAccount(p.accountId);
    return { url: `https://connect.stripe.test/setup/${p.accountId}` };
  }

  async createHold(p: Parameters<PaymentsGateway["createHold"]>[0]) {
    const request = { ...p, idempotencyKey: undefined };
    return this.once(p.idempotencyKey, request, () => {
      this.log.push(`hold.create ${p.agreementId}`);
      const hold: HoldState & { refunded: number } = {
        id: this.id("pi"),
        status: "requires_payment_method",
        amount: p.amount,
        currency: p.currency,
        amount_capturable: 0,
        amount_received: 0,
        capture_before: null,
        extended: false,
        charge_id: null,
        client_secret: null,
        cancellation_reason: null,
        livemode: this.mode === "live",
        metadata: { agreement_id: p.agreementId },
        refunded: 0,
      };
      hold.client_secret = `${hold.id}_secret`;
      this.holds.set(hold.id, hold);
      if (p.paymentMethod) this.authorize(hold, p.paymentMethod, p.extendedAuthorization);
      if (p.sharedPaymentToken) {
        const t = this.sharedTokens.get(p.sharedPaymentToken);
        const nowMs = this.opts.now().getTime();
        if (!t?.active || (t.expires_at && t.expires_at.getTime() <= nowMs)) {
          throw new GatewayError("The shared payment token is not usable.", false, "spt_inactive");
        }
        if (t.currency !== p.currency || t.max_amount < p.amount) {
          throw new GatewayError(
            "The amount exceeds the token's usage limits.",
            false,
            "spt_limit",
          );
        }
        this.authorize(hold, t.paymentMethod, p.extendedAuthorization);
        t.active = false;
      }
      return this.view(hold);
    });
  }

  async getSharedPaymentToken(id: string): Promise<SharedPaymentToken> {
    const t = this.sharedTokens.get(id);
    if (!t)
      throw new GatewayError(`No such shared payment token: '${id}'`, false, "resource_missing");
    const { paymentMethod: _pm, ...token } = t;
    return { ...token };
  }

  /** An agent grants us a shared payment token (mirrors Stripe's test helper). */
  grantSharedPaymentToken(p: {
    currency: string;
    maxAmount: number;
    expiresAt?: Date;
    paymentMethod?: string;
  }): string {
    const id = this.id("spt");
    this.sharedTokens.set(id, {
      id,
      currency: p.currency,
      max_amount: p.maxAmount,
      expires_at: p.expiresAt ?? null,
      active: true,
      card: { brand: "visa", last4: "4242" },
      paymentMethod: p.paymentMethod ?? "pm_card_visa",
    });
    return id;
  }

  /** Simulates the buyer confirming the payment on the client (Stripe.js). */
  confirm(holdId: string, paymentMethod = "pm_card_visa", extended = false) {
    const hold = this.mustHold(holdId);
    this.authorize(hold, paymentMethod, extended);
    return this.view(hold);
  }

  private authorize(hold: HoldState, pm: string, extendedRequested: boolean) {
    if (pm === "pm_card_chargeDeclined") {
      throw new GatewayError("Your card was declined.", false, "card_declined");
    }
    const extended = extendedRequested && pm !== "pm_card_noExtended";
    const days = extended ? AUTH_WINDOW_DAYS.extended : AUTH_WINDOW_DAYS.standard;
    Object.assign(hold, {
      status: "requires_capture",
      amount_capturable: hold.amount,
      capture_before: new Date(this.opts.now().getTime() + days * DAY),
      extended,
      charge_id: this.id("ch"),
    });
  }

  /** Simulates the authorization lapsing (Stripe cancels the payment intent automatically). */
  expire(holdId: string) {
    const hold = this.mustHold(holdId);
    Object.assign(hold, {
      status: "canceled",
      amount_capturable: 0,
      cancellation_reason: "automatic",
    });
  }

  async getHold(id: string) {
    const hold = this.mustHold(id);
    this.lapseIfExpired(hold);
    return this.view(hold);
  }

  async capture(id: string, amount: number, idempotencyKey: string) {
    return this.once(idempotencyKey, ["capture", id, amount], () => {
      const hold = this.mustHold(id);
      this.lapseIfExpired(hold);
      if (hold.status !== "requires_capture") {
        throw new GatewayError(
          `can't capture a payment in status ${hold.status}`,
          false,
          "payment_intent_unexpected_state",
        );
      }
      if (amount <= 0 || amount > hold.amount_capturable) {
        throw new GatewayError(
          "amount_to_capture exceeds the capturable amount",
          false,
          "amount_too_large",
        );
      }
      this.log.push(`hold.capture ${id} ${amount}`);
      Object.assign(hold, { status: "succeeded", amount_received: amount, amount_capturable: 0 });
      return this.view(hold);
    });
  }

  async cancel(id: string, idempotencyKey: string) {
    return this.once(idempotencyKey, ["cancel", id], () => {
      const hold = this.mustHold(id);
      if (hold.status === "succeeded" || hold.status === "canceled") {
        throw new GatewayError(
          `can't cancel a payment in status ${hold.status}`,
          false,
          "payment_intent_unexpected_state",
        );
      }
      this.log.push(`hold.cancel ${id}`);
      Object.assign(hold, {
        status: "canceled",
        amount_capturable: 0,
        cancellation_reason: "requested_by_customer",
      });
      return this.view(hold);
    });
  }

  async refund(p: { holdId: string; amount: number; idempotencyKey: string }) {
    return this.once(p.idempotencyKey, ["refund", p.holdId, p.amount], () => {
      const hold = this.mustHold(p.holdId);
      if (hold.status !== "succeeded" || p.amount > hold.amount_received - hold.refunded) {
        throw new GatewayError("nothing to refund", false, "charge_not_refundable");
      }
      this.log.push(`refund ${p.holdId} ${p.amount}`);
      hold.refunded += p.amount;
      const refund = { id: this.id("re"), holdId: p.holdId, amount: p.amount };
      this.refunds.push(refund);
      return { id: refund.id };
    });
  }

  async transfer(p: Parameters<PaymentsGateway["transfer"]>[0]) {
    const request = { ...p, idempotencyKey: undefined };
    return this.once(p.idempotencyKey, request, () => {
      const account = this.mustAccount(p.destination);
      if (!account.transfers_active) {
        throw new GatewayError(
          "the destination account can't receive transfers yet",
          false,
          "capability_not_active",
        );
      }
      const hold = [...this.holds.values()].find((h) => h.charge_id === p.sourceCharge);
      if (hold?.status !== "succeeded") {
        throw new GatewayError(
          "source transaction isn't captured",
          false,
          "transfer_source_balance_parameters_mismatch",
        );
      }
      this.log.push(`transfer ${p.destination} ${p.amount}`);
      const t = {
        id: this.id("tr"),
        amount: p.amount,
        destination: p.destination,
        agreementId: p.agreementId,
      };
      this.transfers.push(t);
      return { id: t.id, amount: p.amount, currency: p.currency };
    });
  }

  readonly customers = new Map<string, { name: string; email: string; accountId: string }>();
  readonly invoices: {
    id: string;
    customerId: string;
    currency: string;
    period: string;
    lines: { description: string; amount: number }[];
    total: number;
  }[] = [];
  readonly payouts: { id: string; amount: number; currency: string; destination: string }[] = [];

  async createCustomer(p: Parameters<PaymentsGateway["createCustomer"]>[0]) {
    const { idempotencyKey, ...request } = p;
    return this.once(idempotencyKey, request, () => {
      const id = this.id("cus");
      this.customers.set(id, { name: p.name, email: p.email, accountId: p.accountId });
      this.log.push(`customer ${p.accountId}`);
      return { id };
    });
  }

  async createInvoice(p: Parameters<PaymentsGateway["createInvoice"]>[0]) {
    const { idempotencyKey, ...request } = p;
    return this.once(idempotencyKey, request, () => {
      if (!this.customers.has(p.customerId)) {
        throw new GatewayError("no such customer", false, "resource_missing");
      }
      const inv = {
        id: this.id("in"),
        customerId: p.customerId,
        currency: p.currency,
        period: p.period,
        lines: p.lines,
        total: p.lines.reduce((n, l) => n + l.amount, 0),
      };
      this.invoices.push(inv);
      this.log.push(`invoice ${p.customerId} ${inv.total}`);
      return {
        id: inv.id,
        status: "open",
        hostedUrl: `https://invoice.stripe.test/${inv.id}`,
        total: inv.total,
      };
    });
  }

  async payout(p: Parameters<PaymentsGateway["payout"]>[0]) {
    const { idempotencyKey, ...request } = p;
    return this.once(idempotencyKey, request, () => {
      const account = this.mustAccount(p.destination);
      if (!account.transfers_active) {
        throw new GatewayError(
          "the destination account can't receive transfers yet",
          false,
          "capability_not_active",
        );
      }
      const t = {
        id: this.id("tr"),
        amount: p.amount,
        currency: p.currency,
        destination: p.destination,
      };
      this.payouts.push(t);
      this.log.push(`payout ${p.destination} ${p.amount}`);
      return { id: t.id, amount: t.amount, currency: t.currency };
    });
  }

  /** Builds a signed webhook delivery the way Stripe would send it. */
  webhook(type: string, objectId: string, paymentIntentId: string | null = null) {
    const event = {
      id: this.id("evt"),
      type,
      livemode: this.mode === "live",
      data: { object: { id: objectId, payment_intent: paymentIntentId } },
    };
    const body = JSON.stringify(event);
    return { event, body, signature: this.sign(body) };
  }

  private sign(body: string) {
    return `fake=${createHash("sha256")
      .update(`${this.opts.webhookSecret ?? ""}.${body}`)
      .digest("hex")}`;
  }

  parseWebhook(rawBody: string, signature: string): GatewayEvent {
    if (!this.opts.webhookSecret || signature !== this.sign(rawBody))
      throw new WebhookSignatureError();
    const e = JSON.parse(rawBody);
    return {
      id: e.id,
      type: e.type,
      object_id: e.data.object.id,
      payment_intent_id: e.data.object.payment_intent ?? null,
      livemode: e.livemode,
    };
  }

  private lapseIfExpired(hold: HoldState) {
    if (
      hold.status === "requires_capture" &&
      hold.capture_before &&
      this.opts.now().getTime() >= hold.capture_before.getTime()
    ) {
      Object.assign(hold, {
        status: "canceled",
        amount_capturable: 0,
        cancellation_reason: "automatic",
      });
    }
  }

  private view(hold: HoldState & { refunded: number }): HoldState {
    const { refunded: _r, ...rest } = hold;
    return structuredClone(rest);
  }

  private mustHold(id: string) {
    const hold = this.holds.get(id);
    if (!hold) throw new GatewayError(`no such payment intent: ${id}`, false, "resource_missing");
    return hold;
  }

  private mustAccount(id: string) {
    const a = this.accounts.get(id);
    if (!a) throw new GatewayError(`no such account: ${id}`, false, "resource_missing");
    return a;
  }
}
