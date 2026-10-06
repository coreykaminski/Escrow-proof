CREATE TABLE "agreement_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"engine_version" text NOT NULL,
	"report" jsonb NOT NULL,
	"report_hash" text NOT NULL,
	"action" text NOT NULL,
	"outcome" jsonb,
	"confidence" real NOT NULL,
	"cost_usd" real NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_inputs" ADD CONSTRAINT "agreement_inputs_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_inputs_agreement_idx" ON "agreement_inputs" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "verifications_agreement_idx" ON "verifications" USING btree ("agreement_id");