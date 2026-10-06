import { z } from "zod";
import { hashValue } from "./hash.ts";

/**
 * An agreement's spec: what was asked, the checkable acceptance criteria, and the money terms.
 * Its hash is locked on approval, so every later decision can prove which spec it judged against.
 * Keys are snake_case because this exact document is what the API returns and the buyer approves.
 * The Spec Engine (packages/spec-engine) drafts criteria from a plain-language request.
 */
export const CriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase id, 1-64 chars"),
  description: z.string().min(3).max(2000),
  /** How a checker decides pass/fail. Optional, and omitted from the hash when absent. */
  verification: z.string().min(3).max(2000).optional(),
  check: z.enum(["deterministic", "domain", "judge"]),
  critical: z.boolean().default(false),
});

export const VERTICALS = ["translation", "code", "data", "general"] as const;
export type Vertical = (typeof VERTICALS)[number];

export const SpecSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(200),
    request: z.string().min(1).max(20_000),
    vertical: z.enum(VERTICALS),
    criteria: z.array(CriterionSchema).min(1).max(50),
    amount: z.object({
      /** Integer minor units (cents for usd, 1e-6 for usdc). */
      value: z.number().int().positive().max(1_000_000_000_00),
      currency: z.string().regex(/^[a-z]{3,10}$/, "lowercase currency code, e.g. usd or usdc"),
    }),
    /** Normalized to UTC ISO so "...+00:00" and "...Z" hash the same. */
    delivery_due_at: z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString()),
    appeal_window_hours: z.number().int().min(0).max(720).default(72),
    /**
     * Source material the deliverable is judged against (e.g. the document to translate),
     * by hash, so approving the spec also locks the inputs. Content is stored separately.
     */
    inputs: z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          media_type: z.string().min(1).max(100),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .max(20)
      .optional(),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of spec.criteria.entries()) {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate criterion id "${c.id}"`,
          path: ["criteria", i, "id"],
        });
      }
      seen.add(c.id);
    }
  });

export type Spec = z.infer<typeof SpecSchema>;
export type SpecInput = z.input<typeof SpecSchema>;

export function parseSpec(input: unknown): Spec {
  return SpecSchema.parse(input);
}

/** Hash of the normalized spec (defaults applied), so equivalent inputs hash identically. */
export function specHash(spec: Spec): string {
  return hashValue(spec);
}
