ALTER TABLE "accounts" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "content_deleted_at" timestamp with time zone;