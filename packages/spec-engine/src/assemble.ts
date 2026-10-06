import { parseSpec, type Spec, type Vertical } from "@proofdesk/core";
import { ZodError } from "zod";
import { type DraftOutput, SpecDraftError } from "./drafter.ts";

/** Terms that come from the caller, never from the model. */
export interface SpecTerms {
  request: string;
  title?: string;
  vertical?: Vertical;
  amount: { value: number; currency: string };
  delivery_due_at: string;
  appeal_window_hours?: number;
}

const MAX_CRITERIA = 50;

/** Lowercase, kebab-case, ≤64 chars, starting with a letter or digit; "criterion" if empty. */
export function normalizeCriterionId(raw: string): string {
  const id = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return id || "criterion";
}

/** Appends -2, -3… to repeated ids, keeping each within 64 chars. */
function dedupe(ids: string[]): string[] {
  const used = new Set<string>();
  return ids.map((id) => {
    let candidate = id;
    for (let n = 2; used.has(candidate); n++) {
      const suffix = `-${n}`;
      candidate = `${id.slice(0, 64 - suffix.length)}${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Combines a model draft with the caller's terms into a validated spec. Caller-supplied
 * title and vertical win over the draft's; amount, currency and deadline only ever come
 * from the caller.
 */
export function assembleSpec(draft: DraftOutput, terms: SpecTerms): Spec {
  const criteria = draft.criteria
    .filter((c) => c.description.trim().length >= 3)
    .slice(0, MAX_CRITERIA);
  if (criteria.length === 0) {
    throw new SpecDraftError("invalid_draft", "the draft contained no criteria");
  }
  const ids = dedupe(criteria.map((c) => normalizeCriterionId(c.id)));

  try {
    return parseSpec({
      version: 1,
      title: (terms.title ?? draft.title).trim().slice(0, 200) || "Untitled job",
      request: terms.request,
      vertical: terms.vertical ?? draft.vertical,
      criteria: criteria.map((c, i) => ({
        id: ids[i],
        description: c.description.trim(),
        ...(c.verification.trim().length >= 3 ? { verification: c.verification.trim() } : {}),
        check: c.check,
        critical: c.critical,
      })),
      amount: terms.amount,
      delivery_due_at: terms.delivery_due_at,
      ...(terms.appeal_window_hours === undefined
        ? {}
        : { appeal_window_hours: terms.appeal_window_hours }),
    });
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      throw new SpecDraftError(
        "invalid_draft",
        `the draft didn't form a valid spec: ${first?.path.join(".")} ${first?.message}`,
        { cause: err },
      );
    }
    throw err;
  }
}
