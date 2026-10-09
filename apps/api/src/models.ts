import {
  type AnchorGateway,
  AwsKmsSigner,
  accountFrom,
  type ChainGateway,
  type KeySource,
  ViemAnchorGateway,
  ViemChainGateway,
} from "@proofdesk/chain";
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
 * Where each chain role's key lives. Every role takes either <ROLE>_KMS_KEY_ID (an AWS KMS
 * ECC_SECG_P256K1 key, region from AWS_REGION, credentials from the AWS default chain) or
 * <ROLE>_PRIVATE_KEY (development and testnets only).
 *   EVALUATOR  decides on-chain jobs (the trust root)
 *   RELAYER    pays gas to relay gasless funding (optional: defaults to the evaluator)
 *   ANCHOR     posts ledger tree heads (optional off mainnet: defaults to the evaluator)
 */
export type ChainRole = "EVALUATOR" | "RELAYER" | "ANCHOR";

export function keySourceFromEnv(role: ChainRole, env = process.env): KeySource | undefined {
  const kms = env[`${role}_KMS_KEY_ID`];
  if (kms) {
    return {
      kind: "kms",
      signer: new AwsKmsSigner(kms, env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    };
  }
  const key = env[`${role}_PRIVATE_KEY`];
  return key ? { kind: "private_key", key: key as `0x${string}` } : undefined;
}

/** Base mainnet: real money on-chain. */
export const LIVE_CHAIN_IDS = new Set([8453]);

/**
 * The key policy for a live chain (docs/security/evaluator-keys.md): every role on a KMS key,
 * and each role its own key. A raw key is refused unless ALLOW_HOT_KEYS=1 (break-glass only).
 */
export function assertKeyPolicy(env = process.env): void {
  if (!LIVE_CHAIN_IDS.has(Number(env.CHAIN_ID))) return;
  if (env.ALLOW_HOT_KEYS === "1") return;
  const roles = ["EVALUATOR", "RELAYER", "ANCHOR"] as const;
  const ids = roles.map((r) => env[`${r}_KMS_KEY_ID`]);
  const problems = [
    ...roles
      .filter((r, i) => (env.ANCHOR_CONTRACT || r !== "ANCHOR" ? !ids[i] : false))
      .map((r) => `${r}_KMS_KEY_ID is required on a live chain`),
    ...roles
      .filter((r) => env[`${r}_PRIVATE_KEY`])
      .map((r) => `${r}_PRIVATE_KEY must not be set on a live chain`),
    new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length &&
      "each role needs its own KMS key",
  ].filter((x): x is string => typeof x === "string");
  if (problems.length) {
    throw new Error(`refusing to start on chain ${env.CHAIN_ID}: ${problems.join("; ")}`);
  }
}

/**
 * The stablecoin rail when a chain and an evaluator key are configured:
 *   CHAIN_RPC_URL, CHAIN_ID (84532 Base Sepolia, 8453 Base), JOBS_CONTRACT, and the role keys.
 */
export function chainFromEnv(env = process.env): ChainGateway | undefined {
  const { CHAIN_RPC_URL, CHAIN_ID, JOBS_CONTRACT } = env;
  const evaluator = keySourceFromEnv("EVALUATOR", env);
  if (!CHAIN_RPC_URL || !CHAIN_ID || !JOBS_CONTRACT || !evaluator) return undefined;
  assertKeyPolicy(env);
  const relayer = keySourceFromEnv("RELAYER", env);
  return new ViemChainGateway({
    rpcUrl: CHAIN_RPC_URL,
    chainId: Number(CHAIN_ID),
    contract: JOBS_CONTRACT as `0x${string}`,
    evaluator: accountFrom(evaluator),
    ...(relayer ? { relayer: accountFrom(relayer) } : {}),
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

/**
 * Ledger anchoring when ANCHOR_CONTRACT is set (same chain as CHAIN_RPC_URL/CHAIN_ID). Signs with
 * the ANCHOR key; off mainnet it may fall back to the evaluator key.
 */
export function anchorFromEnv(env = process.env): AnchorGateway | undefined {
  const source =
    keySourceFromEnv("ANCHOR", env) ??
    (LIVE_CHAIN_IDS.has(Number(env.CHAIN_ID)) ? undefined : keySourceFromEnv("EVALUATOR", env));
  if (!env.ANCHOR_CONTRACT || !env.CHAIN_RPC_URL || !env.CHAIN_ID || !source) return undefined;
  assertKeyPolicy(env);
  return new ViemAnchorGateway({
    rpcUrl: env.CHAIN_RPC_URL,
    chainId: Number(env.CHAIN_ID),
    contract: env.ANCHOR_CONTRACT as `0x${string}`,
    anchorer: accountFrom(source),
  });
}
