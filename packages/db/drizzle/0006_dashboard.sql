CREATE TABLE "dashboard_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"csrf_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"agreement_id" text NOT NULL,
	"created_by_key_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_links_agreement_idx" ON "share_links" USING btree ("agreement_id");