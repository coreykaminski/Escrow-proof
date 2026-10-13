ALTER TABLE "accounts" ADD COLUMN "self_serve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "contact_email" text;