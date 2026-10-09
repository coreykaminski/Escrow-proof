CREATE TABLE "verdict_seals" (
	"agreement_id" text PRIMARY KEY NOT NULL,
	"salt" text NOT NULL,
	"subject" text NOT NULL,
	"ledger_seq" integer NOT NULL,
	"sealed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verdict_seals_subject_unique" UNIQUE("subject")
);
--> statement-breakpoint
ALTER TABLE "verdict_seals" ADD CONSTRAINT "verdict_seals_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE no action ON UPDATE no action;