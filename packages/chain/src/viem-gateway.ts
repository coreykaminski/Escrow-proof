import {
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  parseEventLogs,
  parseSignature,
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { ierc8183Abi, proofDeskJobsAbi } from "./abi.ts";
import {
  type ChainConfig,
  ChainError,
  type ChainGateway,
  type ExternalJob,
  JOB_STATUSES,
  type JobTerms,
  type OnchainJob,
  type TokenDomain,
} from "./gateway.ts";

const KNOWN_CHAINS: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry,
};

const paymentTokenAbi = [
  {
    type: "function",
    name: "paymentToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export interface ViemChainGatewayOptions {
  rpcUrl: string;
  chainId: number;
  contract: Address;
  /** The evaluator's key: signs settlements and pays gas for relayed funding. */
  evaluatorKey: Hex;
  /** Base mainnet is live; testnets and local chains are test. */
  mode?: "test" | "live";
  /** Blocks to wait after a transaction before trusting it (default 1). */
  confirmations?: number;
  /** How often to poll for receipts (default: viem's, ~block time). */
  pollingIntervalMs?: number;
}

export class ViemChainGateway implements ChainGateway {
  private readonly pub: PublicClient;
  private readonly wallet;
  private readonly account;
  private readonly chain: Chain;
  private readonly contract: Address;
  private cached?: ChainConfig;
  private domain?: TokenDomain;

  constructor(private readonly opts: ViemChainGatewayOptions) {
    this.chain =
      KNOWN_CHAINS[opts.chainId] ??
      defineChain({
        id: opts.chainId,
        name: `chain-${opts.chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [opts.rpcUrl] } },
      });
    const transport = http(opts.rpcUrl);
    const polling = opts.pollingIntervalMs ? { pollingInterval: opts.pollingIntervalMs } : {};
    this.pub = createPublicClient({ chain: this.chain, transport, ...polling }) as PublicClient;
    this.account = privateKeyToAccount(opts.evaluatorKey);
    this.wallet = createWalletClient({
      chain: this.chain,
      transport,
      account: this.account,
      ...polling,
    });
    this.contract = getAddress(opts.contract);
  }

  async config(): Promise<ChainConfig> {
    if (this.cached) return this.cached;
    const token = await this.read(() =>
      this.pub.readContract({
        address: this.contract,
        abi: proofDeskJobsAbi,
        functionName: "paymentToken",
      }),
    );
    this.cached = {
      mode: this.opts.mode ?? (this.opts.chainId === base.id ? "live" : "test"),
      chainId: this.opts.chainId,
      contract: this.contract,
      token: getAddress(token),
      evaluator: this.account.address,
    };
    return this.cached;
  }

  async tokenDomain(): Promise<TokenDomain> {
    if (this.domain) return this.domain;
    const { token, chainId } = await this.config();
    // Circle's FiatToken exposes name() and version() but not always EIP-5267.
    const [name, version] = await this.read(() =>
      Promise.all([
        this.pub.readContract({ address: token, abi: eip712DomainAbi, functionName: "name" }),
        this.pub.readContract({ address: token, abi: eip712DomainAbi, functionName: "version" }),
      ]),
    );
    this.domain = { name, version, chainId, verifyingContract: token };
    return this.domain;
  }

  async getJob(jobId: bigint): Promise<OnchainJob> {
    const j = await this.read(() =>
      this.pub.readContract({
        address: this.contract,
        abi: proofDeskJobsAbi,
        functionName: "getJob",
        args: [jobId],
      }),
    );
    const status = JOB_STATUSES[j.status];
    if (!status) throw new ChainError(`unknown job status ${j.status}`, false);
    return {
      jobId: j.id,
      client: getAddress(j.client),
      provider: getAddress(j.provider),
      evaluator: getAddress(j.evaluator),
      expiredAt: j.expiredAt,
      description: j.description,
      budget: j.budget,
      status,
    };
  }

  async jobFeeBP(jobId: bigint): Promise<number> {
    return this.read(() =>
      this.pub.readContract({
        address: this.contract,
        abi: proofDeskJobsAbi,
        functionName: "jobFeeBP",
        args: [jobId],
      }),
    );
  }

  async jobFromTx(txHash: Hex): Promise<bigint | null> {
    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try {
      receipt = await this.pub.getTransactionReceipt({ hash: txHash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw new ChainError("could not read the transaction", true, "rpc_error", { cause: err });
    }
    if (receipt.status !== "success") return null;
    const funded = parseEventLogs({
      abi: proofDeskJobsAbi,
      eventName: "JobFunded",
      logs: receipt.logs.filter((l) => getAddress(l.address) === this.contract),
    });
    return funded[0]?.args.jobId ?? null;
  }

  async relayFunding(p: {
    terms: JobTerms;
    validAfter: bigint;
    validBefore: bigint;
    signature: Hex;
  }): Promise<{ txHash: Hex; jobId: bigint }> {
    const sig = parseSignature(p.signature);
    const v = Number(sig.v ?? BigInt((sig.yParity ?? 0) + 27));
    const t = p.terms;
    const txHash = await this.write("createAndFundWithAuthorization", [
      t.client,
      t.provider,
      t.evaluator,
      t.expiredAt,
      t.description,
      t.budget,
      p.validAfter,
      p.validBefore,
      v,
      sig.r,
      sig.s,
    ]);
    const jobId = await this.jobFromTx(txHash);
    if (jobId === null) throw new ChainError("the funding transaction funded no job", false);
    return { txHash, jobId };
  }

  async settle(p: { jobId: bigint; releaseBP: number; reason: Hex }): Promise<{ txHash: Hex }> {
    return { txHash: await this.write("settle", [p.jobId, p.releaseBP, p.reason]) };
  }

  async getJobAt(contract: Address, jobId: bigint): Promise<ExternalJob> {
    const address = getAddress(contract);
    const j = await this.read(() =>
      this.pub.readContract({ address, abi: ierc8183Abi, functionName: "getJob", args: [jobId] }),
    );
    const status = JOB_STATUSES[j.status];
    if (!status) throw new ChainError(`unknown job status ${j.status}`, false);
    return {
      contract: address,
      jobId: j.id,
      client: getAddress(j.client),
      provider: getAddress(j.provider),
      evaluator: getAddress(j.evaluator),
      expiredAt: j.expiredAt,
      description: j.description,
      budget: j.budget,
      status,
      hook: getAddress(j.hook),
    };
  }

  async paymentTokenAt(contract: Address): Promise<Address | null> {
    try {
      const token = await this.read(() =>
        this.pub.readContract({
          address: getAddress(contract),
          abi: paymentTokenAbi,
          functionName: "paymentToken",
        }),
      );
      return getAddress(token);
    } catch (err) {
      if (err instanceof ChainError && !err.retryable) return null;
      throw err;
    }
  }

  async complete(p: { contract: Address; jobId: bigint; reason: Hex }) {
    return { txHash: await this.writeAt(p.contract, "complete", [p.jobId, p.reason, "0x"]) };
  }

  async reject(p: { contract: Address; jobId: bigint; reason: Hex }) {
    return { txHash: await this.writeAt(p.contract, "reject", [p.jobId, p.reason, "0x"]) };
  }

  private async writeAt(
    contract: Address,
    functionName: "complete" | "reject",
    args: readonly unknown[],
  ): Promise<Hex> {
    return this.send(getAddress(contract), ierc8183Abi, functionName, args);
  }

  private async write(
    functionName: "settle" | "createAndFundWithAuthorization",
    args: readonly unknown[],
  ): Promise<Hex> {
    return this.send(this.contract, proofDeskJobsAbi, functionName, args);
  }

  /** Simulate (to surface reverts as non-retryable), send, wait for the receipt. */
  private async send(
    address: Address,
    abi: typeof proofDeskJobsAbi | typeof ierc8183Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> {
    try {
      const { request } = await this.pub.simulateContract({
        address,
        abi: abi as typeof proofDeskJobsAbi,
        functionName: functionName as "settle",
        args: args as never,
        account: this.account,
      });
      const hash = await this.wallet.writeContract(request as never);
      const receipt = await this.pub.waitForTransactionReceipt({
        hash,
        confirmations: this.opts.confirmations ?? 1,
      });
      if (receipt.status !== "success") {
        throw new ChainError(`${functionName} transaction reverted`, false, "reverted");
      }
      return hash;
    } catch (err) {
      throw toChainError(err, functionName);
    }
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toChainError(err, "read");
    }
  }
}

function toChainError(err: unknown, what: string): ChainError {
  if (err instanceof ChainError) return err;
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? "reverted";
      return new ChainError(`${what} reverted: ${name}`, false, name, { cause: err });
    }
    return new ChainError(`${what} failed: ${err.shortMessage}`, true, "rpc_error", { cause: err });
  }
  return new ChainError(`${what} failed`, true, "rpc_error", { cause: err });
}
