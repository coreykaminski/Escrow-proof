CREATE TABLE "onchain_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"contract" text NOT NULL,
	"job_id" text,
	"client" text,
	"provider" text NOT NULL,
	"evaluator" text NOT NULL,
	"description" text NOT NULL,
	"budget" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"fund_tx" text,
	"settle_tx" text,
	"settlement" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onchain_jobs_agreement_id_unique" UNIQUE("agreement_id")
);
--> statement-breakpoint
CREATE TABLE "seller_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"seller_ref" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onchain_jobs" ADD CONSTRAINT "onchain_jobs_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_wallets" ADD CONSTRAINT "seller_wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_jobs_job_idx" ON "onchain_jobs" USING btree ("chain_id","contract","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_wallets_ref_idx" ON "seller_wallets" USING btree ("account_id","seller_ref");