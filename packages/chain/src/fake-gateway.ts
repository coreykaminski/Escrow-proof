import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  recoverTypedDataAddress,
  toHex,
} from "viem";
import {
  authorizationTypedData,
  type ChainConfig,
  ChainError,
  type ChainGateway,
  type JobTerms,
  type OnchainJob,
  splitBudget,
  type TokenDomain,
} from "./gateway.ts";

const MIN_EXPIRY_LEAD = 300n;
export const FEE_RECIPIENT = getAddress("0x000000000000000000000000000000000000fee5");

/**
 * In-memory stand-in for the ProofDeskJobs contract, with the same rules (who may act, which
 * states, expiry, fee snapshot, single-use authorizations). Tests play the client's wallet with
 * `fundFromWallet` and move time with the injected clock.
 */
export class FakeChainGateway implements ChainGateway {
  readonly jobs = new Map<bigint, OnchainJob & { feeBP: number }>();
  readonly balances = new Map<Address, bigint>();
  readonly settlements: { jobId: bigint; releaseBP: number; reason: Hex; txHash: Hex }[] = [];
  private readonly txJobs = new Map<Hex, bigint>();
  private readonly usedNonces = new Set<string>();
  private nextJob = 1n;
  private txCount = 0;
  /** Set to make the next settle fail like an RPC outage. */
  failNextSettle: ChainError | null = null;

  private readonly cfg: ChainConfig;

  constructor(
    cfg: Partial<ChainConfig> = {},
    private readonly now: () => Date = () => new Date(),
    readonly feeBP = 200,
  ) {
    this.cfg = {
      mode: cfg.mode ?? "test",
      chainId: cfg.chainId ?? 84532,
      contract: getAddress(cfg.contract ?? "0x00000000000000000000000000000000000fa4e1"),
      token: getAddress(cfg.token ?? "0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
      evaluator: getAddress(cfg.evaluator ?? "0x00000000000000000000000000000000000e7a10"),
    };
  }

  async config() {
    return this.cfg;
  }

  async tokenDomain(): Promise<TokenDomain> {
    return {
      name: "USDC",
      version: "2",
      chainId: this.cfg.chainId,
      verifyingContract: this.cfg.token,
    };
  }

  async getJob(jobId: bigint): Promise<OnchainJob> {
    const j = this.jobs.get(jobId);
    if (!j) throw new ChainError("job not found", false, "InvalidParams");
    const { feeBP: _fee, ...job } = j;
    return { ...job };
  }

  async jobFeeBP(jobId: bigint) {
    return this.jobs.get(jobId)?.feeBP ?? 0;
  }

  async jobFromTx(txHash: Hex) {
    return this.txJobs.get(txHash) ?? null;
  }

  /** The client's own wallet sends createAndFund (test helper). */
  fundFromWallet(terms: JobTerms): Hex {
    return this.create(terms).txHash;
  }

  async relayFunding(p: {
    terms: JobTerms;
    validAfter: bigint;
    validBefore: bigint;
    signature: Hex;
  }): Promise<{ txHash: Hex; jobId: bigint }> {
    const nowS = this.nowSeconds();
    if (nowS <= p.validAfter || nowS >= p.validBefore) {
      throw new ChainError("authorization not valid now", false, "authorization_window");
    }
    const typed = authorizationTypedData(
      this.cfg,
      await this.tokenDomain(),
      p.terms,
      p.validAfter,
      p.validBefore,
    );
    const key = `${p.terms.client}:${typed.message.nonce}`;
    if (this.usedNonces.has(key)) throw new ChainError("authorization used", false, "reverted");
    const signer = await recoverTypedDataAddress({ ...typed, signature: p.signature });
    if (getAddress(signer) !== getAddress(p.terms.client)) {
      throw new ChainError("invalid signature", false, "reverted");
    }
    this.usedNonces.add(key);
    return this.create(p.terms);
  }

  async settle(p: { jobId: bigint; releaseBP: number; reason: Hex }): Promise<{ txHash: Hex }> {
    if (this.failNextSettle) {
      const e = this.failNextSettle;
      this.failNextSettle = null;
      throw e;
    }
    const j = this.jobs.get(p.jobId);
    if (!j) throw new ChainError("settle reverted: InvalidParams", false, "InvalidParams");
    if (j.status !== "funded" && j.status !== "submitted") {
      throw new ChainError("settle reverted: InvalidState", false, "InvalidState");
    }
    if (p.releaseBP > 0 && this.nowSeconds() >= j.expiredAt) {
      throw new ChainError("settle reverted: Expired", false, "Expired");
    }
    const s = splitBudget(j.budget, p.releaseBP, j.feeBP);
    j.status = p.releaseBP === 0 ? "rejected" : "completed";
    this.credit(j.provider, s.toProvider);
    this.credit(j.client, s.toClient);
    this.credit(FEE_RECIPIENT, s.fee);
    const txHash = this.tx();
    this.settlements.push({ ...p, txHash });
    return { txHash };
  }

  /** Anyone may reclaim an expired job's funds for the client (test helper). */
  claimRefund(jobId: bigint) {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== "funded" && j.status !== "submitted")) throw new Error("InvalidState");
    if (this.nowSeconds() < j.expiredAt) throw new Error("NotExpired");
    j.status = "expired";
    this.credit(j.client, j.budget);
  }

  private create(t: JobTerms) {
    if (t.provider === t.client || t.evaluator === t.client || t.evaluator === t.provider) {
      throw new ChainError("createAndFund reverted: InvalidParams", false, "InvalidParams");
    }
    if (t.expiredAt <= this.nowSeconds() + MIN_EXPIRY_LEAD || t.budget <= 0n) {
      throw new ChainError("createAndFund reverted: InvalidParams", false, "InvalidParams");
    }
    const jobId = this.nextJob++;
    this.jobs.set(jobId, { ...t, jobId, status: "funded", feeBP: this.feeBP });
    const txHash = this.tx();
    this.txJobs.set(txHash, jobId);
    return { txHash, jobId };
  }

  private credit(who: Address, amount: bigint) {
    if (amount > 0n) this.balances.set(who, (this.balances.get(who) ?? 0n) + amount);
  }

  private tx(): Hex {
    return keccak256(toHex(`fake-tx-${++this.txCount}`));
  }

  private nowSeconds() {
    return BigInt(Math.floor(this.now().getTime() / 1000));
  }
}
