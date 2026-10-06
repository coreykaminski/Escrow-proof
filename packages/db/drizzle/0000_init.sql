CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"buyer_ref" text NOT NULL,
	"seller_ref" text NOT NULL,
	"livemode" boolean NOT NULL,
	"status" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"spec_approved_at" timestamp with time zone,
	"amount_value" bigint NOT NULL,
	"currency" text NOT NULL,
	"delivery_due_at" timestamp with time zone NOT NULL,
	"appeal_window_hours" integer NOT NULL,
	"hold_rail" text,
	"hold_ref" text,
	"funded_at" timestamp with time zone,
	"outcome" jsonb,
	"decided_at" timestamp with time zone,
	"dispute_resolved" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone,
	"settlement_ref" text,
	"cancelled_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"mode" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"actor_ref" text NOT NULL,
	"confidence" real,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"artifacts" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"opened_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_decision_id" text
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_account_id_key_pk" PRIMARY KEY("account_id","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"prev_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"agreement_id" text,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "ledger_entries_entry_hash_unique" UNIQUE("entry_hash")
);
--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolution_decision_id_decisions_id_fk" FOREIGN KEY ("resolution_decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreements_account_idx" ON "agreements" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "agreements_status_idx" ON "agreements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "decisions_agreement_idx" ON "decisions" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "deliveries_agreement_idx" ON "deliveries" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "disputes_agreement_idx" ON "disputes" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "ledger_agreement_idx" ON "ledger_entries" USING btree ("agreement_id","seq");