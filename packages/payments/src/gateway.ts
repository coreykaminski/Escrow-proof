/**
 * What Proof Desk needs from a card processor, in its own terms. StripeGateway implements it
 * against Stripe; FakeGateway simulates Stripe's semantics in memory for tests.
 *
 * Proof Desk never takes custody of funds itself: an authorization hold stays on the buyer's
 * card until release (capture + transfer to the seller's connected account) or refund (cancel).
 */

/** A card hold, as the processor reports it. Amounts are integer minor units. */
export interface HoldState {
  id: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "canceled"
    | "succeeded";
  amount: number;
  currency: string;
  /** Still capturable (authorized, not yet captured). */
  amount_capturable: number;
  /** Captured so far. */
  amount_received: number;
  /** After this the authorization lapses; null until authorized. */
  capture_before: Date | null;
  /** The issuer granted an extended authorization window (up to ~30 days). */
  extended: boolean;
  charge_id: string | null;
  client_secret: string | null;
  cancellation_reason: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
}

export interface SellerAccountState {
  id: string;
  details_submitted: boolean;
  /** Can receive transfers (needed to be paid on release). */
  transfers_active: boolean;
  payouts_enabled: boolean;
}

export interface GatewayEvent {
  id: string;
  type: string;
  /** The id of the object the event is about (payment intent, account, dispute…). */
  object_id: string;
  /** For dispute/charge events: the payment intent they belong to, when known. */
  payment_intent_id: string | null;
  livemode: boolean;
}

export interface PaymentsGateway {
  readonly mode: "test" | "live";

  createSellerAccount(p: {
    sellerRef: string;
    idempotencyKey: string;
  }): Promise<SellerAccountState>;
  getSellerAccount(id: string): Promise<SellerAccountState>;
  createOnboardingLink(p: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  /** Authorize (not capture) a card payment for an agreement. */
  createHold(p: {
    amount: number;
    currency: string;
    agreementId: string;
    description: string;
    /** Confirm immediately with this payment method (server-side / agent flows). */
    paymentMethod?: string;
    /** Ask the issuer for an extended authorization window (jobs that run past ~7 days). */
    extendedAuthorization: boolean;
    idempotencyKey: string;
  }): Promise<HoldState>;
  getHold(id: string): Promise<HoldState>;
  /** Capture all or part of an authorized hold; the rest of the authorization is released. */
  capture(id: string, amount: number, idempotencyKey: string): Promise<HoldState>;
  /** Release the authorization entirely (refund before capture: no fee, no chargeback). */
  cancel(id: string, idempotencyKey: string): Promise<HoldState>;
  /** Refund captured funds. */
  refund(p: { holdId: string; amount: number; idempotencyKey: string }): Promise<{ id: string }>;
  /** Pay the seller from captured funds (separate charges and transfers). */
  transfer(p: {
    amount: number;
    currency: string;
    destination: string;
    agreementId: string;
    sourceCharge: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;

  /** Verify a webhook's signature and parse it; throws WebhookSignatureError if invalid. */
  parseWebhook(rawBody: string, signature: string): GatewayEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message = "invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/** A processor rejected or failed an operation. `retryable` = safe to try again later. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}
