CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"agreement_id" text,
	"livemode" boolean NOT NULL,
	"amount" integer NOT NULL,
	"description" text NOT NULL,
	"period" text NOT NULL,
	"invoice_id" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"period" text NOT NULL,
	"stripe_invoice_id" text,
	"status" text NOT NULL,
	"total" integer NOT NULL,
	"hosted_url" text,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"period" text NOT NULL,
	"decisions" integer NOT NULL,
	"dispute_resolutions" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"destination" text NOT NULL,
	"transfer_id" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "plan" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_payouts" ADD CONSTRAINT "reviewer_payouts_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_ref_idx" ON "billing_events" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "billing_events_account_period_idx" ON "billing_events" USING btree ("account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_account_period_idx" ON "invoices" USING btree ("account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_payouts_key_period_idx" ON "reviewer_payouts" USING btree ("api_key_id","period");