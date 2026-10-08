import { type ChainGateway, ViemChainGateway } from "@proofdesk/chain";
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
    extendedAuthorization: env.STRIPE_EXTENDED_AUTH === "on",
  });
}

/**
 * The stablecoin rail when a chain and evaluator key are configured:
 *   CHAIN_RPC_URL, CHAIN_ID (84532 Base Sepolia, 8453 Base), JOBS_CONTRACT, EVALUATOR_PRIVATE_KEY
 */
export function chainFromEnv(env = process.env): ChainGateway | undefined {
  const { CHAIN_RPC_URL, CHAIN_ID, JOBS_CONTRACT, EVALUATOR_PRIVATE_KEY } = env;
  if (!CHAIN_RPC_URL || !CHAIN_ID || !JOBS_CONTRACT || !EVALUATOR_PRIVATE_KEY) return undefined;
  return new ViemChainGateway({
    rpcUrl: CHAIN_RPC_URL,
    chainId: Number(CHAIN_ID),
    contract: JOBS_CONTRACT as `0x${string}`,
    evaluatorKey: EVALUATOR_PRIVATE_KEY as `0x${string}`,
  });
}
