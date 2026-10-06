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
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id")
      .notNull()
      .references(() => agreements.id),
    kind: text("kind").$type<"verification" | "deadline" | "dispute_resolution">().notNull(),
    outcome: jsonb("outcome").$type<Outcome>().notNull(),
    decidedBy: text("decided_by").$type<"auto" | "human">().notNull(),
    actorRef: text("actor_ref").notNull(),
    confidence: real("confidence"),
    reason: text("reason").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("decisions_agreement_idx").on(t.agreementId)],
);

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
