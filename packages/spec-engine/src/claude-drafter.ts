import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  type DraftInput,
  DraftOutputSchema,
  type DraftResult,
  SpecDraftError,
  type SpecDrafter,
} from "./drafter.ts";
import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.ts";

export const DEFAULT_SPEC_MODEL = "claude-opus-5-5";

export interface ClaudeSpecDrafterOptions {
  /** Defaults to a client built from the environment (ANTHROPIC_API_KEY). */
  client?: Anthropic;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Drafts criteria with Claude, using structured outputs so the reply always fits the schema. */
export class ClaudeSpecDrafter implements SpecDrafter {
  private readonly client: Anthropic;
  readonly model: string;
  private readonly effort: NonNullable<ClaudeSpecDrafterOptions["effort"]>;

  constructor(opts: ClaudeSpecDrafterOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_SPEC_MODEL;
    this.effort = opts.effort ?? "medium";
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    let response: Awaited<ReturnType<typeof this.client.beta.messages.parse>>;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16_000,
        // If a safety classifier declines, the API retries on its recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(input.request, input.vertical) }],
        output_config: { effort: this.effort, format: betaZodOutputFormat(DraftOutputSchema) },
      });
    } catch (err) {
      throw toDraftError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new SpecDraftError(
        "refused",
        `the model declined to draft criteria for this request${
          response.stop_details?.category ? ` (${response.stop_details.category})` : ""
        }`,
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new SpecDraftError("failed", "the draft was cut off before it finished");
    }
    const output = response.parsed_output;
    if (!output) throw new SpecDraftError("failed", "the model returned no parseable draft");

    return {
      output,
      meta: {
        model: response.model,
        prompt_version: PROMPT_VERSION,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

function toDraftError(err: unknown): SpecDraftError {
  if (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  ) {
    return new SpecDraftError("unavailable", "the drafting model is unavailable; retry shortly", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    return new SpecDraftError("failed", `drafting failed (${err.status ?? "no status"})`, {
      cause: err,
    });
  }
  return new SpecDraftError("failed", "drafting failed", { cause: err });
}
