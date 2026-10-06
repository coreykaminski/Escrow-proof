import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/** USD per million tokens (input, output). */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function costOf(model: string, input: number, output: number): number {
  const [i, o] = PRICES[model] ?? [4, 20];
  return (input * i + output * o) / 1e6;
}

export class ModelCallError extends Error {
  constructor(
    readonly code: "refused" | "unavailable" | "failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelCallError";
  }
}

/** Anything that can make a structured call: the real client, or a stub in tests. */
export interface StructuredCaller {
  call<S extends z.ZodType>(params: {
    model: string;
    effort: "low" | "medium" | "high";
    system: string;
    user: string;
    schema: S;
  }): Promise<{ output: z.infer<S>; usage: Usage; model: string }>;
}

export class ClaudeCaller implements StructuredCaller {
  private client: Anthropic | undefined;
  constructor(private readonly opts: { client?: Anthropic } = {}) {}

  async call<S extends z.ZodType>(params: {
    model: string;
    effort: "low" | "medium" | "high";
    system: string;
    user: string;
    schema: S;
  }) {
    this.client ??= this.opts.client ?? new Anthropic();
    let response: Awaited<ReturnType<Anthropic["beta"]["messages"]["parse"]>>;
    try {
      response = await this.client.beta.messages.parse({
        model: params.model,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: params.system,
        messages: [{ role: "user", content: params.user }],
        output_config: { effort: params.effort, format: betaZodOutputFormat(params.schema) },
      });
    } catch (err) {
      const retryable =
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError;
      throw new ModelCallError(retryable ? "unavailable" : "failed", "model call failed", {
        cause: err,
      });
    }
    if (response.stop_reason === "refusal") {
      throw new ModelCallError("refused", "the model declined to review this deliverable");
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new ModelCallError("failed", "the model returned no usable review");
    }
    const { input_tokens, output_tokens } = response.usage;
    return {
      output: response.parsed_output as z.infer<S>,
      model: response.model,
      usage: {
        input_tokens,
        output_tokens,
        cost_usd: costOf(response.model, input_tokens, output_tokens),
      },
    };
  }
}
