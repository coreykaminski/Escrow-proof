import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

let client: Anthropic | undefined;

/** One structured-output call; throws on refusal, truncation or unparseable output. */
export async function structured<S extends z.ZodType>(
  schema: S,
  system: string,
  user: string,
  opts: { model?: string; effort?: "low" | "medium" | "high"; maxTokens?: number } = {},
): Promise<{ output: z.infer<S>; usage: { input_tokens: number; output_tokens: number } }> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: opts.model ?? "claude-opus-5-5",
    max_tokens: opts.maxTokens ?? 16_000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(schema) },
  });
  if (response.stop_reason === "refusal") throw new Error("model refused");
  if (response.stop_reason === "max_tokens") throw new Error("output truncated");
  if (!response.parsed_output) throw new Error("no parseable output");
  return { output: response.parsed_output, usage: response.usage };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
