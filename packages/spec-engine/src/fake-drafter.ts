import type { DraftInput, DraftOutput, DraftResult, SpecDrafter } from "./drafter.ts";
import { PROMPT_VERSION } from "./prompt.ts";

/** Deterministic drafter for tests and offline dev. Records every call. */
export class FakeSpecDrafter implements SpecDrafter {
  readonly calls: DraftInput[] = [];
  /** Set to make the next draft() reject (once). */
  failNext: Error | null = null;

  constructor(private readonly respond: (input: DraftInput) => DraftOutput = defaultDraft) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    this.calls.push(input);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return {
      output: this.respond(input),
      meta: {
        model: "fake-drafter",
        prompt_version: PROMPT_VERSION,
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }
}

function defaultDraft(input: DraftInput): DraftOutput {
  return {
    title: `Job: ${input.request.slice(0, 40)}`,
    vertical: input.vertical ?? "general",
    criteria: [
      {
        id: "complete",
        description: "Every item the request asks for is present in the deliverable",
        verification: "List each requested item and confirm each appears",
        check: "judge",
        critical: true,
      },
      {
        id: "format",
        description: "Delivered as a single plain-text file",
        verification: "Exactly one artifact with media type text/plain",
        check: "deterministic",
        critical: false,
      },
    ],
    open_questions: [],
  };
}
