import type { Db, SpecSource } from "@proofdesk/db";
import {
  assembleSpec,
  type ImportedMandate,
  type SpecDrafter,
  type SpecTerms,
} from "@proofdesk/spec-engine";
import { ApiError } from "../errors.ts";
import { type AgreementRow, createAgreement } from "./agreements.ts";

export interface DraftAgreementInput {
  accountId: string;
  livemode: boolean;
  buyerRef: string;
  sellerRef: string;
  terms: SpecTerms;
  metadata: Record<string, string>;
  mandate?: ImportedMandate;
  now: Date;
}

/**
 * Request → drafted criteria → a draft agreement the buyer can edit (PUT /spec) and approve
 * by hash. The model call happens before any transaction, so a slow draft holds no locks.
 */
export async function draftAgreement(
  db: Db,
  drafter: SpecDrafter | undefined,
  input: DraftAgreementInput,
): Promise<AgreementRow> {
  if (!drafter) {
    throw new ApiError(
      503,
      "spec_engine_unavailable",
      "spec drafting isn't configured on this server (set ANTHROPIC_API_KEY)",
    );
  }
  const { output, meta } = await drafter.draft({
    request: input.terms.request,
    vertical: input.terms.vertical,
  });
  const spec = assembleSpec(output, input.terms);

  const specSource: SpecSource = {
    kind: "drafted",
    model: meta.model,
    prompt_version: meta.prompt_version,
    open_questions: output.open_questions,
    ...(input.mandate
      ? {
          mandate: {
            type: input.mandate.type,
            hash: input.mandate.mandate_hash,
            signature_verified: input.mandate.signature_verified,
          },
        }
      : {}),
  };

  return createAgreement(db, {
    accountId: input.accountId,
    livemode: input.livemode,
    buyerRef: input.buyerRef,
    sellerRef: input.sellerRef,
    spec,
    specSource,
    metadata: input.metadata,
    now: input.now,
  });
}

/** A cart mandate's total is the signed price; a caller amount may only restate it. */
export function resolveMandateAmount(
  mandate: ImportedMandate,
  callerAmount: { value: number; currency: string } | undefined,
): { value: number; currency: string } {
  if (mandate.amount) {
    if (
      callerAmount &&
      (callerAmount.value !== mandate.amount.value ||
        callerAmount.currency !== mandate.amount.currency)
    ) {
      throw new ApiError(
        400,
        "amount_mismatch",
        `amount must match the cart mandate total (${mandate.amount.value} ${mandate.amount.currency})`,
      );
    }
    return mandate.amount;
  }
  if (!callerAmount) {
    throw new ApiError(400, "amount_required", "an intent mandate has no price; send amount");
  }
  return callerAmount;
}
