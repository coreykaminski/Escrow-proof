import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ledgerAnchorAbi } from "./abi.ts";
import { ChainError } from "./gateway.ts";

/** One posted ledger head. */
export interface LedgerAnchorRecord {
  seq: number;
  headHash: string;
  /** Unix seconds (chain time). */
  timestamp: number;
}

/** Posts the ledger head to the LedgerAnchor contract and reads anchors back. */
export interface AnchorGateway {
  readonly chainId: number;
  readonly contract: Address;
  latest(): Promise<LedgerAnchorRecord | null>;
  /** All anchors, oldest first (for verification tools). */
  list(): Promise<LedgerAnchorRecord[]>;
  anchor(seq: number, headHash: string): Promise<{ txHash: Hex }>;
}

const toBytes32 = (hex: string): Hex => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new ChainError("ledger hashes are 32-byte hex", false);
  return `0x${hex}`;
};

export class ViemAnchorGateway implements AnchorGateway {
  readonly contract: Address;
  private readonly pub: PublicClient;
  private readonly wallet: Promise<ReturnType<typeof createWalletClient>>;

  constructor(
    private readonly opts: {
      rpcUrl: string;
      chainId: number;
      contract: Address;
      /** A raw key (development, testnets), or `anchorer`: an account, e.g. KMS-backed. */
      anchorerKey?: Hex;
      anchorer?: Account | Promise<Account>;
      pollingIntervalMs?: number;
    },
  ) {
    this.contract = getAddress(opts.contract);
    const transport = http(opts.rpcUrl);
    const polling = opts.pollingIntervalMs ? { pollingInterval: opts.pollingIntervalMs } : {};
    this.pub = createPublicClient({ transport, ...polling }) as PublicClient;
    if (!opts.anchorer && !opts.anchorerKey) throw new Error("an anchorer key is required");
    this.wallet = Promise.resolve(
      opts.anchorer ?? privateKeyToAccount(opts.anchorerKey as Hex),
    ).then((account) => createWalletClient({ transport, account, ...polling }));
    this.wallet.catch(() => {});
  }

  get chainId() {
    return this.opts.chainId;
  }

  async latest() {
    const a = await this.pub.readContract({
      address: this.contract,
      abi: ledgerAnchorAbi,
      functionName: "latest",
    });
    return a.seq === 0n ? null : toRecord(a);
  }

  async list() {
    const n = await this.pub.readContract({
      address: this.contract,
      abi: ledgerAnchorAbi,
      functionName: "count",
    });
    const out: LedgerAnchorRecord[] = [];
    for (let i = 0n; i < n; i++) {
      out.push(
        toRecord(
          await this.pub.readContract({
            address: this.contract,
            abi: ledgerAnchorAbi,
            functionName: "get",
            args: [i],
          }),
        ),
      );
    }
    return out;
  }

  async anchor(seq: number, headHash: string) {
    try {
      const { request } = await this.pub.simulateContract({
        address: this.contract,
        abi: ledgerAnchorAbi,
        functionName: "anchor",
        args: [BigInt(seq), toBytes32(headHash)],
        account: (await this.wallet).account,
      });
      const hash = await (await this.wallet).writeContract(request as never);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new ChainError("anchor transaction reverted", false);
      return { txHash: hash };
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        `anchor failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
        true,
        "rpc_error",
        { cause: err },
      );
    }
  }
}

function toRecord(a: { seq: bigint; timestamp: bigint; headHash: Hex }): LedgerAnchorRecord {
  return { seq: Number(a.seq), headHash: a.headHash.slice(2), timestamp: Number(a.timestamp) };
}

/** In-memory LedgerAnchor with the same rules (forward-only), for tests. */
export class FakeAnchorGateway implements AnchorGateway {
  readonly chainId = 84532;
  readonly contract = getAddress("0x00000000000000000000000000000000000a4c40");
  readonly anchors: LedgerAnchorRecord[] = [];
  private n = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async latest() {
    return this.anchors.at(-1) ?? null;
  }

  async list() {
    return [...this.anchors];
  }

  async anchor(seq: number, headHash: string) {
    toBytes32(headHash);
    const last = this.anchors.at(-1);
    if (seq <= 0 || (last && seq <= last.seq)) {
      throw new ChainError("anchor reverted: NotForward", false, "NotForward");
    }
    this.anchors.push({ seq, headHash, timestamp: Math.floor(this.now().getTime() / 1000) });
    return { txHash: `0x${(++this.n).toString(16).padStart(64, "0")}` as Hex };
  }
}
