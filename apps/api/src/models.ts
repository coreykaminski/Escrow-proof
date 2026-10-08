import { type ChainGateway, ViemChainGateway } from "@proofdesk/chain";
import { type PaymentsGateway, StripeGateway } from "@proofdesk/payments";
import { ClaudeSpecDrafter, type SpecDrafter } from "@proofdesk/spec-engine";
import {
  ClaudeCaller,
  DockerSandbox,
  NodePermissionSandbox,
  verifyCode,
  verifyData,
  verifyTranslation,
} from "@proofdesk/verifier";
import { DEFAULT_REVIEWER_RATES, type ReviewerRates } from "./services/billing.ts";
import type { CodeVerifier, DataVerifier, TranslationVerifier } from "./services/verification.ts";

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

/**
 * The code verifier. Its sandboxed test layer needs no API key; the model judge joins when
 * ANTHROPIC_API_KEY is set. CODE_SANDBOX picks the sandbox: "docker" (production default:
 * no network, read-only, unprivileged; DOCKER_RUNTIME=runsc for gVisor) or "node" (Node's
 * permission model; development and CI only).
 */
export function codeVerifierFromEnv(env = process.env): CodeVerifier {
  const kind = env.CODE_SANDBOX ?? (env.NODE_ENV === "production" ? "docker" : "node");
  const sandbox =
    kind === "docker"
      ? new DockerSandbox(env.DOCKER_RUNTIME ? { ociRuntime: env.DOCKER_RUNTIME } : {})
      : new NodePermissionSandbox();
  const caller = env.ANTHROPIC_API_KEY ? new ClaudeCaller() : undefined;
  return (input) => verifyCode(input, { sandbox, ...(caller ? { caller } : {}) });
}

/** The data/research verifier: deterministic checks always; the model judge with a key. */
export function dataVerifierFromEnv(env = process.env): DataVerifier {
  const caller = env.ANTHROPIC_API_KEY ? new ClaudeCaller() : undefined;
  return (input) => verifyData(input, caller ? { caller } : {});
}

/** Development conveniences that must be off in production. */
export function allowPrivateNetworkFromEnv(env = process.env): boolean {
  if (env.ALLOW_PRIVATE_NETWORK === "1") return true;
  if (env.ALLOW_PRIVATE_NETWORK === "0") return false;
  return env.NODE_ENV !== "production";
}

/**
 * Reviewer payout currency and rates (minor units). On a Canadian Stripe account, payouts from
 * the balance must be in CAD: REVIEWER_PAYOUT_CURRENCY=cad.
 */
export function reviewerRatesFromEnv(env = process.env): ReviewerRates {
  return {
    currency: env.REVIEWER_PAYOUT_CURRENCY ?? DEFAULT_REVIEWER_RATES.currency,
    decision: Number(env.REVIEWER_RATE_DECISION ?? DEFAULT_REVIEWER_RATES.decision),
    disputeResolution: Number(
      env.REVIEWER_RATE_DISPUTE ?? DEFAULT_REVIEWER_RATES.disputeResolution,
    ),
  };
}
