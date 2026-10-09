CREATE TABLE "decision_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"verification_id" text,
	"auto_outcome" jsonb NOT NULL,
	"reviewed_outcome" jsonb NOT NULL,
	"agreed" boolean NOT NULL,
	"override_decision_id" text,
	"reviewer_ref" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "shadow_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "review_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_reviews" ADD CONSTRAINT "decision_reviews_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_reviews" ADD CONSTRAINT "decision_reviews_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_reviews" ADD CONSTRAINT "decision_reviews_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_reviews" ADD CONSTRAINT "decision_reviews_override_decision_id_decisions_id_fk" FOREIGN KEY ("override_decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_reviews_decision_idx" ON "decision_reviews" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "decision_reviews_created_idx" ON "decision_reviews" USING btree ("created_at");