import type { AgreementState, Outcome, Spec } from "@proofdesk/core";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Where invoices go. */
  billingEmail: text("billing_email"),
  /** Stripe Billing customer, created on the first invoice. */
  stripeCustomerId: text("stripe_customer_id"),
  /** "verify_only" accounts pay a monthly minimum on verification fees. */
  plan: text("plan").$type<"standard" | "verify_only">().notNull().default("standard"),
  /** Pilot shadow mode: every automatic decision waits for a human review before it settles. */
  shadowMode: boolean("shadow_mode").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** First characters of the key, safe to show in dashboards/logs. */
    prefix: text("prefix").notNull(),
    /** sha256 of the full key; the key itself is never stored. */
    keyHash: text("key_hash").notNull().unique(),
    mode: text("mode").$type<"test" | "live">().notNull(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_account_idx").on(t.accountId)],
);

export type ApiScope = "platform" | "ops";

/** Provenance of an agreement's current spec; snake_case because it's returned as-is. */
export type SpecSource =
  | { kind: "manual" }
  | {
      kind: "drafted";
      model: string;
      prompt_version: string;
      /** Ambiguities the drafter wanted the buyer to resolve before approving. */
      open_questions: string[];
      /** True once the spec was replaced after drafting. */
      edited?: boolean;
      /** Set when the request came from an AP2 mandate. */
      mandate?: { type: "intent" | "cart"; hash: string; signature_verified: boolean };
    };

export const agreements = pgTable(
  "agreements",
  {
    id: text("id").primaryKey(),
    /** The platform account that created the agreement and acts for its buyer and seller. */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    buyerRef: text("buyer_ref").notNull(),
    sellerRef: text("seller_ref").notNull(),
    /** false = created with a test-mode key; test agreements can only use the test rail. */
    livemode: boolean("livemode").notNull(),
    status: text("status").$type<AgreementState>().notNull(),
    spec: jsonb("spec").$type<Spec>().notNull(),
    specHash: text("spec_hash").notNull(),
    /** Where the current spec came from (manual, drafted, AP2 mandate). Null before Part 2. */
    specSource: jsonb("spec_source").$type<SpecSource>(),
    specApprovedAt: ts("spec_approved_at"),
    amountValue: bigint("amount_value", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    deliveryDueAt: ts("delivery_due_at").notNull(),
    appealWindowHours: integer("appeal_window_hours").notNull(),
    holdRail: text("hold_rail"),
    holdRef: text("hold_ref"),
    fundedAt: ts("funded_at"),
    outcome: jsonb("outcome").$type<Outcome>(),
    decidedAt: ts("decided_at"),
    disputeResolved: boolean("dispute_resolved").notNull().default(false),
    /** An automatic decision awaiting its shadow review (pilot accounts). */
    reviewPending: boolean("review_pending").notNull().default(false),
    settledAt: ts("settled_at"),
    settlementRef: text("settlement_ref"),
    cancelledAt: ts("cancelled_at"),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    /** Optimistic-concurrency counter; bumped on every transition. */
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("agreements_account_idx").on(t.accountId, t.createdAt),
    index("agreements_status_idx").on(t.status),
  ],
);

export interface Artifact {
  name: string;
  mediaType: string;
  content: string;
  sha256: string;
}

export const deliveries = pgTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    artifacts: jsonb("artifacts").$type<Artifact[]>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    submittedAt: ts("submitted_at").notNull(),
  },
  (t) => [index("deliveries_agreement_idx").on(t.agreementId)],
);

/** A seller's Stripe Connect (Express) account, per platform account. */
export const sellerAccounts = pgTable(
  "seller_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    sellerRef: text("seller_ref").notNull(),
    stripeAccountId: text("stripe_account_id").notNull().unique(),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    transfersActive: boolean("transfers_active").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("seller_accounts_ref_idx").on(t.accountId, t.sellerRef)],
);

export type HoldStatus =
  | "pending" // created, waiting for the buyer to confirm the card
  | "authorized" // funds held on the card
  | "captured" // captured to the platform balance (early, before the authorization lapsed)
  | "settled" // final money movements done
  | "canceled" // authorization released without settlement
  | "expired"; // authorization lapsed before it could be captured

/** A card hold backing an agreement (one per agreement). */
export const holds = pgTable("holds", {
  id: text("id").primaryKey(),
  agreementId: text("agreement_id")
    .notNull()
    .unique()
    .references(() => agreements.id),
  rail: text("rail").$type<"card">().notNull(),
  paymentIntentId: text("payment_intent_id").notNull().unique(),
  status: text("status").$type<HoldStatus>().notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  chargeId: text("charge_id"),
  captureBefore: ts("capture_before"),
  extended: boolean("extended").notNull().default(false),
  capturedAmount: bigint("captured_amount", { mode: "number" }).notNull().default(0),
  /** Settlement result: what moved where. */
  settlement: jsonb("settlement").$type<Record<string, unknown>>(),
  disputed: boolean("disputed").notNull().default(false),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/** A seller's stablecoin payout address: the provider on on-chain jobs. */
export const sellerWallets = pgTable(
  "seller_wallets",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    sellerRef: text("seller_ref").notNull(),
    /** EIP-55 checksummed. */
    address: text("address").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("seller_wallets_ref_idx").on(t.accountId, t.sellerRef)],
);

export type OnchainJobStatus =
  | "awaiting_funding" // terms issued; the buyer hasn't funded yet
  | "funded" // USDC locked in the job contract
  | "settled" // the evaluator settled it (or it ended on-chain consistently with the decision)
  | "expired"; // the job expired and the client reclaimed the funds on-chain

/**
 * An ERC-8183 job on the ProofDeskJobs contract backing an agreement (one per agreement). The
 * terms are fixed when first issued so a buyer's signature stays valid.
 */
export const onchainJobs = pgTable(
  "onchain_jobs",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .unique()
      .references(() => agreements.id),
    chainId: integer("chain_id").notNull(),
    contract: text("contract").notNull(),
    /**
     * native: a job on our ProofDeskJobs contract, created from the agreement's terms.
     * external: a job someone created on any ERC-8183 contract, naming Proof Desk as evaluator.
     */
    kind: text("kind").$type<"native" | "external">().notNull().default("native"),
    /** The contract's job id (uint256, as a decimal string); null until funded. */
    jobId: text("job_id"),
    client: text("client"),
    provider: text("provider").notNull(),
    evaluator: text("evaluator").notNull(),
    description: text("description").notNull(),
    /** Token base units (USDC: 6 decimals). */
    budget: bigint("budget", { mode: "number" }).notNull(),
    expiresAt: ts("expires_at").notNull(),
    status: text("status").$type<OnchainJobStatus>().notNull(),
    fundTx: text("fund_tx"),
    settleTx: text("settle_tx"),
    settlement: jsonb("settlement").$type<Record<string, unknown>>(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  // One on-chain job can back only one agreement.
  (t) => [uniqueIndex("onchain_jobs_job_idx").on(t.chainId, t.contract, t.jobId)],
);

/**
 * A platform's endpoint for outbound webhooks. Events are ledger entries for the platform's
 * agreements, delivered in ledger order; `cursorSeq` is the last one acknowledged.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    /** Event type prefixes to send (e.g. "agreement.", "hold.settled"); empty = all. */
    eventTypes: text("event_types").array().$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    cursorSeq: bigint("cursor_seq", { mode: "number" }).notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("webhook_endpoints_account_idx").on(t.accountId)],
);

/** Delivery attempts, for debugging a platform's endpoint. */
export const webhookAttempts = pgTable(
  "webhook_attempts",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id),
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("webhook_attempts_endpoint_idx").on(t.endpointId, t.createdAt)],
);

/** Dashboard sign-ins: an API key exchanged for a session cookie. Only hashes are stored. */
export const dashboardSessions = pgTable("dashboard_sessions", {
  idHash: text("id_hash").primaryKey(),
  apiKeyId: text("api_key_id")
    .notNull()
    .references(() => apiKeys.id),
  csrfToken: text("csrf_token").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
});

/**
 * Unguessable links: "report" opens an agreement's public verdict report, "pay" opens the
 * hosted card page for its hold. Stored as hashes; revocable; expiring.
 */
export const shareLinks = pgTable(
  "share_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind").$type<"report" | "pay">().notNull(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    createdByKeyId: text("created_by_key_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("share_links_agreement_idx").on(t.agreementId)],
);

/** Processed webhook deliveries, so a replayed or duplicated event is handled once. */
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull(),
});

/** Source material attached to an agreement; listed by hash in spec.inputs. */
export const agreementInputs = pgTable(
  "agreement_inputs",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("agreement_inputs_agreement_idx").on(t.agreementId)],
);

/** One run of the automated verifier on one delivery; the full report is kept for audit. */
export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    engineVersion: text("engine_version").notNull(),
    report: jsonb("report").notNull(),
    reportHash: text("report_hash").notNull(),
    action: text("action").$type<"decide" | "escalate">().notNull(),
    outcome: jsonb("outcome").$type<Outcome>(),
    confidence: real("confidence").notNull(),
    costUsd: real("cost_usd").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verifications_agreement_idx").on(t.agreementId)],
);

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    kind: text("kind")
      .$type<"verification" | "deadline" | "dispute_resolution" | "review_override">()
      .notNull(),
    outcome: jsonb("outcome").$type<Outcome>().notNull(),
    decidedBy: text("decided_by").$type<"auto" | "human">().notNull(),
    actorRef: text("actor_ref").notNull(),
    confidence: real("confidence"),
    reason: text("reason").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("decisions_agreement_idx").on(t.agreementId)],
);

/**
 * Shadow reviews (pilot mode): a human's verdict on an automatic decision. Disagreements are the
 * raw material for new golden-set items (MASTER_PLAN §8: every false verdict becomes a test).
 */
export const decisionReviews = pgTable(
  "decision_reviews",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    /** The automatic decision under review. */
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id),
    /** The verification that produced it, when there was one. */
    verificationId: text("verification_id").references(() => verifications.id),
    autoOutcome: jsonb("auto_outcome").$type<Outcome>().notNull(),
    reviewedOutcome: jsonb("reviewed_outcome").$type<Outcome>().notNull(),
    agreed: boolean("agreed").notNull(),
    /** The override decision, when the reviewer disagreed. */
    overrideDecisionId: text("override_decision_id").references(() => decisions.id),
    reviewerRef: text("reviewer_ref").notNull(),
    reason: text("reason").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("decision_reviews_decision_idx").on(t.decisionId),
    index("decision_reviews_created_idx").on(t.createdAt),
  ],
);

/**
 * Content-free verdict records sealed into the ledger (core/verdict.ts). The salt is secret:
 * only the agreement's parties receive it, so only they can link the public record to a deal.
 */
export const verdictSeals = pgTable("verdict_seals", {
  agreementId: text("agreement_id")
    .primaryKey()
    .references(() => agreements.id),
  salt: text("salt").notNull(),
  subject: text("subject").notNull().unique(),
  /** The ledger entry ("verdict.sealed") holding the record. */
  ledgerSeq: integer("ledger_seq").notNull(),
  sealedAt: ts("sealed_at").notNull(),
});

export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    openedBy: text("opened_by").$type<"buyer" | "seller">().notNull(),
    reason: text("reason").notNull(),
    status: text("status").$type<"open" | "resolved">().notNull(),
    openedAt: ts("opened_at").notNull(),
    resolvedAt: ts("resolved_at"),
    resolutionDecisionId: text("resolution_decision_id").references(() => decisions.id),
  },
  (t) => [index("disputes_agreement_idx").on(t.agreementId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    /** Null while the first request is still in flight. */
    statusCode: integer("status_code"),
    responseBody: jsonb("response_body"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

/** Append-only (enforced by triggers in a custom migration). See core/ledger.ts. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey(),
    prevHash: text("prev_hash").notNull(),
    entryHash: text("entry_hash").notNull().unique(),
    agreementId: text("agreement_id"),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ledger_agreement_idx").on(t.agreementId, t.seq)],
);

/**
 * A billable usage event (a verification run, a dispute resolution), written in the same
 * transaction as the event it bills for. `ref` is the verification/dispute id, so it's billed
 * once. Only live-mode events are invoiced.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").$type<"verification" | "dispute">().notNull(),
    ref: text("ref").notNull(),
    agreementId: text("agreement_id").references(() => agreements.id),
    livemode: boolean("livemode").notNull(),
    /** USD cents. */
    amount: integer("amount").notNull(),
    description: text("description").notNull(),
    /** "YYYY-MM" */
    period: text("period").notNull(),
    invoiceId: text("invoice_id"),
    occurredAt: ts("occurred_at").notNull(),
  },
  (t) => [
    uniqueIndex("billing_events_ref_idx").on(t.kind, t.ref),
    index("billing_events_account_period_idx").on(t.accountId, t.period),
  ],
);

/** One invoice per account per period. */
export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    period: text("period").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    status: text("status").notNull(),
    /** USD cents. */
    total: integer("total").notNull(),
    hostedUrl: text("hosted_url"),
    lines: jsonb("lines").$type<{ description: string; amount: number }[]>().notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("invoices_account_period_idx").on(t.accountId, t.period)],
);

/** What a human reviewer was paid for a period (one row per reviewer key per period). */
export const reviewerPayouts = pgTable(
  "reviewer_payouts",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    period: text("period").notNull(),
    decisions: integer("decisions").notNull(),
    disputeResolutions: integer("dispute_resolutions").notNull(),
    /** In `currency` minor units. */
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    destination: text("destination").notNull(),
    transferId: text("transfer_id"),
    status: text("status").$type<"paid" | "failed">().notNull(),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("reviewer_payouts_key_period_idx").on(t.apiKeyId, t.period)],
);

/** Small operational facts (scheduler heartbeat), keyed by name. */
export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/** Fixed-window request counters shared by every API instance (apps/api security.ts). */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: ts("reset_at").notNull(),
  },
  (t) => [index("rate_limits_reset_idx").on(t.resetAt)],
);
