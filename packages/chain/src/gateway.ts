import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  toBytes,
} from "viem";
import { proofDeskJobsAbi } from "./abi.ts";

/**
 * What Proof Desk needs from the stablecoin rail. The job contract (ProofDeskJobs, ERC-8183)
 * holds the funds; Proof Desk is only its evaluator, so all it can ever do is settle a funded
 * job between the job's own provider and client. ViemChainGateway talks to a real chain;
 * FakeChainGateway mirrors the contract in memory for tests.
 */

export type JobStatus = "open" | "funded" | "submitted" | "completed" | "rejected" | "expired";
export const JOB_STATUSES: readonly JobStatus[] = [
  "open",
  "funded",
  "submitted",
  "completed",
  "rejected",
  "expired",
];

/** The terms a job is created with. Amounts are token base units (USDC: 6 decimals). */
export interface JobTerms {
  client: Address;
  provider: Address;
  evaluator: Address;
  /** Unix seconds. After this the client can always reclaim the funds. */
  expiredAt: bigint;
  description: string;
  budget: bigint;
}

export interface OnchainJob extends JobTerms {
  jobId: bigint;
  status: JobStatus;
}

/** A job on someone else's ERC-8183 contract (evaluator-for-hire); may carry a hook contract. */
export interface ExternalJob extends OnchainJob {
  contract: Address;
  hook: Address;
}

export interface ChainConfig {
  mode: "test" | "live";
  chainId: number;
  /** The ProofDeskJobs contract. */
  contract: Address;
  /** The stablecoin it holds (USDC). */
  token: Address;
  /** Proof Desk's evaluator address. */
  evaluator: Address;
}

/** EIP-712 domain of the token, for EIP-3009 authorizations. */
export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface ChainGateway {
  config(): Promise<ChainConfig>;
  tokenDomain(): Promise<TokenDomain>;
  getJob(jobId: bigint): Promise<OnchainJob>;
  /** The fee rate locked into a job when it was created, in basis points. */
  jobFeeBP(jobId: bigint): Promise<number>;
  /** The job a successful funding transaction on our contract funded; null if none. */
  jobFromTx(txHash: Hex): Promise<bigint | null>;
  /** Submits a client's signed EIP-3009 authorization (gasless funding); we pay the gas. */
  relayFunding(p: {
    terms: JobTerms;
    validAfter: bigint;
    validBefore: bigint;
    signature: Hex;
  }): Promise<{ txHash: Hex; jobId: bigint }>;
  /** The evaluator's decision: releaseBP of the budget to the provider, the rest refunded. */
  settle(p: { jobId: bigint; releaseBP: number; reason: Hex }): Promise<{ txHash: Hex }>;

  // Any standard ERC-8183 contract on the same chain, where Proof Desk is the job's evaluator.
  getJobAt(contract: Address, jobId: bigint): Promise<ExternalJob>;
  /** The contract's `paymentToken()`, or null when it doesn't expose one. */
  paymentTokenAt(contract: Address): Promise<Address | null>;
  /** ERC-8183 `complete`: pays the provider. The job must be Submitted. */
  complete(p: { contract: Address; jobId: bigint; reason: Hex }): Promise<{ txHash: Hex }>;
  /** ERC-8183 `reject`: refunds the client. */
  reject(p: { contract: Address; jobId: bigint; reason: Hex }): Promise<{ txHash: Hex }>;
}

/** A chain call failed. `retryable` = safe to try again later (RPC trouble, not a revert). */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChainError";
  }
}

/** Mirrors ProofDeskJobs.authorizationNonce: binds a signature to one job's exact terms. */
export function authorizationNonce(
  cfg: Pick<ChainConfig, "chainId" | "contract">,
  t: JobTerms,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        BigInt(cfg.chainId),
        cfg.contract,
        t.client,
        t.provider,
        t.evaluator,
        t.expiredAt,
        keccak256(toBytes(t.description)),
        t.budget,
      ],
    ),
  );
}

/** EIP-712 typed data the client's wallet signs for gasless funding (eth_signTypedData_v4). */
export function authorizationTypedData(
  cfg: Pick<ChainConfig, "chainId" | "contract">,
  domain: TokenDomain,
  t: JobTerms,
  validAfter: bigint,
  validBefore: bigint,
) {
  return {
    domain,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: t.client,
      to: cfg.contract,
      value: t.budget,
      validAfter,
      validBefore,
      nonce: authorizationNonce(cfg, t),
    },
  };
}

/** The two transactions a client sends from its own wallet: approve, then createAndFund. */
export function fundingCalls(
  cfg: Pick<ChainConfig, "contract" | "token">,
  t: Omit<JobTerms, "client">,
) {
  return [
    {
      to: cfg.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [cfg.contract, t.budget],
      }),
      description: "Approve the job contract to take the budget",
    },
    {
      to: cfg.contract,
      data: encodeFunctionData({
        abi: proofDeskJobsAbi,
        functionName: "createAndFund",
        args: [t.provider, t.evaluator, t.expiredAt, t.description, t.budget],
      }),
      description: "Create and fund the job",
    },
  ];
}

/** x402 network name for a chain id. */
export function networkName(chainId: number): string {
  return chainId === 8453
    ? "base"
    : chainId === 84532
      ? "base-sepolia"
      : chainId === 31337
        ? "anvil"
        : `eip155:${chainId}`;
}

/** Basis points of the budget released to the provider for a decision. */
export function releaseBasisPoints(
  outcome: { kind: "release" } | { kind: "refund" } | { kind: "partial"; releasePercent: number },
): number {
  return outcome.kind === "release"
    ? 10_000
    : outcome.kind === "refund"
      ? 0
      : outcome.releasePercent * 100;
}

/** Who gets what when a job settles, mirroring the contract's integer arithmetic. */
export function splitBudget(budget: bigint, releaseBP: number, feeBP: number) {
  const released = (budget * BigInt(releaseBP)) / 10_000n;
  const fee = (released * BigInt(feeBP)) / 10_000n;
  return { released, fee, toProvider: released - fee, toClient: budget - released };
}
