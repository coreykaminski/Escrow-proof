import { VERTICALS, type Vertical } from "@proofdesk/core";
import { z } from "zod";

/**
 * What the model drafts. Money terms and deadlines are deliberately absent: they always
 * come from the caller, so nothing in a buyer's request text can change what gets paid.
 */
export const DraftOutputSchema = z.object({
  title: z.string().describe("Short job title, under 80 characters"),
  vertical: z.enum(VERTICALS),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("kebab-case, unique, under 40 characters"),
        description: z
          .string()
          .describe("One pass/fail requirement, observable in the deliverable"),
        verification: z.string().describe("How a checker decides pass/fail"),
        check: z.enum(["deterministic", "domain", "judge"]),
        critical: z.boolean(),
      }),
    )
    .describe("3-12 acceptance criteria"),
  open_questions: z
    .array(z.string())
    .describe("Ambiguities the buyer should resolve before approving; empty if none"),
});

export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface DraftInput {
  /** The buyer's request, as written. Untrusted. */
  request: string;
  /** When the caller already knows the vertical, the draft is steered to (and forced to) it. */
  vertical?: Vertical;
}

export interface DraftMeta {
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
}

export interface DraftResult {
  output: DraftOutput;
  meta: DraftMeta;
}

export interface SpecDrafter {
  draft(input: DraftInput): Promise<DraftResult>;
}

export type SpecDraftErrorCode =
  | "refused" // the model declined the request
  | "unavailable" // rate limited / overloaded / network; safe to retry
  | "failed" // the model returned nothing usable
  | "invalid_draft"; // output parsed but can't become a valid spec

export class SpecDraftError extends Error {
  constructor(
    readonly code: SpecDraftErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SpecDraftError";
  }
}
