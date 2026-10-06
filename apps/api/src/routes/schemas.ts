import { AGREEMENT_STATES, type Outcome, SpecSchema, VERTICALS } from "@proofdesk/core";
import { z } from "zod";

const ref = z.string().min(1).max(255);
const reason = z.string().min(1).max(5000);

export const CreateAgreementBody = z.object({
  buyer_ref: ref,
  seller_ref: ref,
  spec: SpecSchema,
  metadata: z.record(z.string().max(40), z.string().max(500)).default({}),
});

export const ReplaceSpecBody = z.object({ spec: SpecSchema });

/** Terms the caller fixes for a drafted spec; validated before any model call is made. */
const draftTerms = {
  buyer_ref: ref,
  seller_ref: ref,
  title: SpecSchema.shape.title.optional(),
  vertical: z.enum(VERTICALS).optional(),
  delivery_due_at: SpecSchema.shape.delivery_due_at,
  appeal_window_hours: z.number().int().min(0).max(720).optional(),
  metadata: z.record(z.string().max(40), z.string().max(500)).default({}),
};

export const FromRequestBody = z.object({
  ...draftTerms,
  request: SpecSchema.shape.request,
  amount: SpecSchema.shape.amount,
});

export const FromMandateBody = z.object({
  ...draftTerms,
  mandate_type: z.enum(["intent", "cart"]),
  /** The AP2 mandate object as issued; validated by the importer. */
  mandate: z.record(z.string(), z.unknown()),
  /** Required for intent mandates (no price); must equal the total for cart mandates. */
  amount: SpecSchema.shape.amount.optional(),
});

export const ApproveSpecBody = z.object({
  /** The hash of the spec the buyer was shown; must equal the current spec hash. */
  spec_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const CancelBody = z.object({ actor: z.enum(["buyer", "seller"]), reason });

export const FundBody = z.object({
  /** Only the test rail exists until Part 4 (Stripe) and Part 7 (stablecoins). */
  rail: z.literal("test"),
  hold_ref: ref,
});

export const DeliveryBody = z.object({
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        media_type: z.string().min(1).max(100),
        content: z.string().max(1_000_000),
      }),
    )
    .min(1)
    .max(20),
});

export const DisputeBody = z.object({ opened_by: z.enum(["buyer", "seller"]), reason });

export const OutcomeBody = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("release") }),
    z.object({ kind: z.literal("refund") }),
    z.object({ kind: z.literal("partial"), release_percent: z.number().int().min(1).max(99) }),
  ])
  .transform(
    (o): Outcome =>
      o.kind === "partial" ? { kind: "partial", releasePercent: o.release_percent } : o,
  );

export const DecideBody = z.object({
  outcome: OutcomeBody,
  reason,
  confidence: z.number().min(0).max(1).nullable().default(null),
});

export const ResolveDisputeBody = z.object({ outcome: OutcomeBody, reason });

export const SettleBody = z.object({ settlement_ref: ref, force: z.boolean().default(false) });

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(AGREEMENT_STATES).optional(),
});
