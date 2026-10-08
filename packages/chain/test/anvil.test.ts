import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizationNonce,
  authorizationTypedData,
  fundingCalls,
  ledgerAnchorAbi,
  ledgerAnchorBytecode,
  mockUsdcAbi,
  mockUsdcBytecode,
  proofDeskJobsAbi,
  proofDeskJobsBytecode,
  splitBudget,
  ViemAnchorGateway,
  ViemChainGateway,
} from "../src/index.ts";

/**
 * Runs the real contract on a local anvil chain through ViemChainGateway. Skipped when Foundry
 * isn't installed (CI installs it).
 */
const anvilBin = ["anvil", join(homedir(), ".foundry/bin/anvil")].find((p) =>
  p === "anvil" ? process.env.CI === "true" : existsSync(p),
);

// anvil's well-known dev keys (public; never hold real funds).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  evaluator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  client: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  provider: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

describe.skipIf(!anvilBin)("ProofDeskJobs on anvil", () => {
  const port = 18_545 + Math.floor(Math.random() * 1000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
  const wallet = (key: Hex) =>
    createWalletClient({
      chain: foundry,
      transport,
      account: privateKeyToAccount(key),
      pollingInterval: 50,
    });
  const addr = (key: Hex) => privateKeyToAccount(key).address;
  let anvil: ChildProcess;
  let usdc: Address;
  let jobs: Address;
  let gw: ViemChainGateway;

  const balance = (who: Address) =>
    pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [who] });
  const now = async () => (await pub.getBlock()).timestamp;

  beforeAll(async () => {
    anvil = spawn(anvilBin as string, ["--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const deployer = wallet(KEYS.deployer);
    const deploy = async (abi: never, bytecode: Hex, args: unknown[] = []) => {
      const hash = await deployer.deployContract({ abi, bytecode, args } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      return getAddress(r.contractAddress as Address);
    };
    usdc = await deploy(mockUsdcAbi as never, mockUsdcBytecode);
    jobs = await deploy(proofDeskJobsAbi as never, proofDeskJobsBytecode, [
      usdc,
      addr(KEYS.deployer),
      200,
      addr(KEYS.deployer),
    ]);
    const mint = await deployer.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: "mint",
      args: [addr(KEYS.client), parseUnits("1000", 6)],
    });
    await pub.waitForTransactionReceipt({ hash: mint });
    gw = new ViemChainGateway({
      rpcUrl,
      chainId: foundry.id,
      contract: jobs,
      evaluatorKey: KEYS.evaluator,
      pollingIntervalMs: 50,
    });
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  const terms = async (budget: bigint, description: string) => ({
    client: addr(KEYS.client),
    provider: addr(KEYS.provider),
    evaluator: addr(KEYS.evaluator),
    expiredAt: (await now()) + 7n * 86_400n,
    description,
    budget,
  });

  it("reads its config from the contract", async () => {
    const cfg = await gw.config();
    expect(cfg).toMatchObject({ chainId: 31337, contract: jobs, token: usdc, mode: "test" });
    expect(cfg.evaluator).toBe(addr(KEYS.evaluator));
  });

  it("wallet funding → jobFromTx → partial settle pays out the exact split", async () => {
    const t = await terms(parseUnits("180", 6), "proofdesk:agr_1:spec:aa");
    const cfg = await gw.config();
    const client = wallet(KEYS.client);
    let last: Hex = "0x";
    for (const call of fundingCalls(cfg, t)) {
      last = await client.sendTransaction({ to: call.to, data: call.data });
      await pub.waitForTransactionReceipt({ hash: last });
    }
    const jobId = await gw.jobFromTx(last);
    expect(jobId).not.toBeNull();
    const job = await gw.getJob(jobId as bigint);
    expect(job).toMatchObject({ status: "funded", budget: t.budget, description: t.description });
    expect(await gw.jobFeeBP(jobId as bigint)).toBe(200);

    const providerBefore = await balance(t.provider);
    const clientBefore = await balance(t.client);
    await gw.settle({ jobId: jobId as bigint, releaseBP: 6000, reason: `0x${"ab".repeat(32)}` });
    const s = splitBudget(t.budget, 6000, 200);
    expect((await balance(t.provider)) - providerBefore).toBe(s.toProvider);
    expect((await balance(t.client)) - clientBefore).toBe(s.toClient);
    expect((await gw.getJob(jobId as bigint)).status).toBe("completed");
  });

  it("the TS nonce matches the contract's", async () => {
    const t = await terms(1_000_000n, "nonce check");
    const onchain = await pub.readContract({
      address: jobs,
      abi: proofDeskJobsAbi,
      functionName: "authorizationNonce",
      args: [t.client, t.provider, t.evaluator, t.expiredAt, t.description, t.budget],
    });
    expect(authorizationNonce(await gw.config(), t)).toBe(onchain);
  });

  it("gasless funding: client signs, evaluator relays, refund decision returns everything", async () => {
    const t = await terms(parseUnits("50", 6), "proofdesk:agr_2:spec:bb");
    const validBefore = t.expiredAt;
    const typed = authorizationTypedData(
      await gw.config(),
      await gw.tokenDomain(),
      t,
      0n,
      validBefore,
    );
    const signature = await wallet(KEYS.client).signTypedData(typed);
    const clientBefore = await balance(t.client);
    const { jobId } = await gw.relayFunding({ terms: t, validAfter: 0n, validBefore, signature });
    expect((await gw.getJob(jobId)).status).toBe("funded");
    expect(clientBefore - (await balance(t.client))).toBe(t.budget);

    await expect(
      gw.relayFunding({ terms: t, validAfter: 0n, validBefore, signature }),
    ).rejects.toMatchObject({ retryable: false });

    await gw.settle({ jobId, releaseBP: 0, reason: `0x${"cd".repeat(32)}` });
    expect(await balance(t.client)).toBe(clientBefore);
    expect((await gw.getJob(jobId)).status).toBe("rejected");
  });

  it("a revert surfaces as a non-retryable ChainError with the error name", async () => {
    await expect(
      gw.settle({ jobId: 1n, releaseBP: 0, reason: `0x${"00".repeat(32)}` }),
    ).rejects.toMatchObject({
      retryable: false,
      code: "InvalidState",
    });
  });

  it("anchors ledger heads forward-only and reads them back", async () => {
    const deployer = wallet(KEYS.deployer);
    const hash = await deployer.deployContract({
      abi: ledgerAnchorAbi,
      bytecode: ledgerAnchorBytecode,
      args: [addr(KEYS.deployer), addr(KEYS.evaluator)],
    } as never);
    const address = getAddress(
      (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address,
    );
    const anchors = new ViemAnchorGateway({
      rpcUrl,
      chainId: foundry.id,
      contract: address,
      anchorerKey: KEYS.evaluator,
      pollingIntervalMs: 50,
    });
    expect(await anchors.latest()).toBeNull();
    await anchors.anchor(7, "a".repeat(64));
    await anchors.anchor(12, "b".repeat(64));
    await expect(anchors.anchor(12, "c".repeat(64))).rejects.toThrow();
    expect(await anchors.latest()).toMatchObject({ seq: 12, headHash: "b".repeat(64) });
    expect((await anchors.list()).map((a) => a.seq)).toEqual([7, 12]);
  });
});
