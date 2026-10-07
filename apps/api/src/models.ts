import { type PaymentsGateway, StripeGateway } from "@proofdesk/payments";
import { ClaudeSpecDrafter, type SpecDrafter } from "@proofdesk/spec-engine";
import { ClaudeCaller, verifyTranslation } from "@proofdesk/verifier";
import type { TranslationVerifier } from "./services/verification.ts";

/** The Claude drafter when an API key is configured; otherwise drafting endpoints return 503. */
export function drafterFromEnv(env = process.env): SpecDrafter | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return new ClaudeSpecDrafter(env.SPEC_DRAFT_MODEL ? { model: env.SPEC_DRAFT_MODEL } : {});
}

/** The Claude-backed translation verifier when an API key is configured. */
export function verifierFromEnv(env = process.env): TranslationVerifier | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  const caller = new ClaudeCaller();
  return (input) => verifyTranslation(input, { caller });
}

/** Stripe when STRIPE_SECRET_KEY is set (test keys for test-mode agreements). */
export function paymentsFromEnv(env = process.env): PaymentsGateway | undefined {
  if (!env.STRIPE_SECRET_KEY) return undefined;
  return new StripeGateway({
    secretKey: env.STRIPE_SECRET_KEY,
    ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
  });
}
