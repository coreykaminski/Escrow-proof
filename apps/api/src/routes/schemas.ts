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

export const InputsBody = z.object({
  inputs: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        media_type: z.string().min(1).max(100),
        content: z.string().max(1_000_000),
      }),
    )
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

/** settlement_ref is required for the test rail; card settlements generate their own. */
export const SettleBody = z.object({
  settlement_ref: ref.optional(),
  force: z.boolean().default(false),
});

export const CardHoldBody = z.object({
  /** Confirm server-side with a saved/agent payment method (e.g. pm_card_visa in test mode). */
  payment_method: z.string().min(1).max(255).optional(),
});

export const OnboardingBody = z.object({
  /** Where Stripe reaches the seller about onboarding and payouts. */
  email: z.email(),
  /** The seller's country (ISO 3166-1 alpha-2). Stripe needs it before onboarding. */
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default("us"),
  return_url: z.url().optional(),
  refresh_url: z.url().optional(),
});

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(AGREEMENT_STATES).optional(),
});

export const LinkBody = z.object({ expires_in_days: z.number().int().min(1).max(90).default(30) });
