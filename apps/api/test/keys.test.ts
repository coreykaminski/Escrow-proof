/** Evaluator key hardening: the live-chain key policy, and settling only with the job's own key. */
import { FakeChainGateway } from "@proofdesk/chain";
import { schema } from "@proofdesk/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { anchorFromEnv, assertKeyPolicy, keySourceFromEnv } from "../src/models.ts";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const base = {
  CHAIN_RPC_URL: "http://127.0.0.1:1",
  JOBS_CONTRACT: "0x0000000000000000000000000000000000000001",
};

describe("key policy", () => {
  it("allows raw keys on testnets", () => {
    expect(() =>
      assertKeyPolicy({ ...base, CHAIN_ID: "84532", EVALUATOR_PRIVATE_KEY: KEY }),
    ).not.toThrow();
  });

  it("refuses raw keys and shared keys on Base mainnet", () => {
    expect(() =>
      assertKeyPolicy({ ...base, CHAIN_ID: "8453", EVALUATOR_PRIVATE_KEY: KEY }),
    ).toThrow(
      /EVALUATOR_KMS_KEY_ID is required.*RELAYER_KMS_KEY_ID is required.*EVALUATOR_PRIVATE_KEY must not be set/,
    );
    expect(() =>
      assertKeyPolicy({
        ...base,
        CHAIN_ID: "8453",
        EVALUATOR_KMS_KEY_ID: "k1",
        RELAYER_KMS_KEY_ID: "k1",
      }),
    ).toThrow("each role needs its own KMS key");
    expect(() =>
      assertKeyPolicy({
        ...base,
        CHAIN_ID: "8453",
        ANCHOR_CONTRACT: "0x2",
        EVALUATOR_KMS_KEY_ID: "k1",
        RELAYER_KMS_KEY_ID: "k2",
      }),
    ).toThrow("ANCHOR_KMS_KEY_ID is required");
  });

  it("accepts separate KMS keys on mainnet, and has a break-glass override", () => {
    const env = { ...base, CHAIN_ID: "8453", EVALUATOR_KMS_KEY_ID: "k1", RELAYER_KMS_KEY_ID: "k2" };
    expect(() => assertKeyPolicy(env)).not.toThrow();
    expect(keySourceFromEnv("EVALUATOR", env)?.kind).toBe("kms");
    expect(() =>
      assertKeyPolicy({
        ...base,
        CHAIN_ID: "8453",
        EVALUATOR_PRIVATE_KEY: KEY,
        ALLOW_HOT_KEYS: "1",
      }),
    ).not.toThrow();
  });

  it("anchoring never borrows the evaluator key on mainnet", () => {
    const env = { ...base, ANCHOR_CONTRACT: "0x0000000000000000000000000000000000000002" };
    expect(anchorFromEnv({ ...env, CHAIN_ID: "84532", EVALUATOR_PRIVATE_KEY: KEY })).toBeDefined();
    expect(
      anchorFromEnv({
        ...env,
        CHAIN_ID: "8453",
        EVALUATOR_KMS_KEY_ID: "k1",
        RELAYER_KMS_KEY_ID: "k2",
      }),
    ).toBeUndefined();
  });
});

describe("retired evaluator keys", () => {
  let h: Harness;
  let chain: FakeChainGateway;
  afterEach(async () => {
    await h?.close();
  });

  it("refuses to settle a job funded under another evaluator key, saying which", async () => {
    h = await createHarness({
      chain: (now) => {
        chain = new FakeChainGateway(undefined, now);
        return chain;
      },
    });
    const A = h.keys.platformA;
    await h.call(A, "PUT", "/v1/sellers/s/wallet", {
      address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    });
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture({
          amount: { value: 1_000_000, currency: "usdc" },
          appeal_window_hours: 1,
        }),
      })
    ).body;
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
    const f = (await h.call(A, "POST", `/v1/agreements/${agr.id}/onchain-job`)).body;
    const tx = chain.fundFromWallet({
      client: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      provider: f.terms.provider,
      evaluator: f.terms.evaluator,
      expiredAt: BigInt(f.terms.expired_at),
      description: f.terms.description,
      budget: BigInt(f.terms.budget),
    });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/onchain-job/confirm`, { tx_hash: tx });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
      artifacts: [{ name: "o.txt", media_type: "text/plain", content: "x" }],
    });
    await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/start-verification`);
    await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/decide`, {
      outcome: { kind: "release" },
      reason: "ok",
    });
    // Simulate a key rotation: the job was funded under a key this server no longer holds.
    const retired = "0x00000000000000000000000000000000000000AA";
    await h.handle.db
      .update(schema.onchainJobs)
      .set({ evaluator: retired })
      .where(eq(schema.onchainJobs.agreementId, agr.id));
    h.clock.advance(2 * HOUR);
    const res = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/settle`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("evaluator_key_mismatch");
    expect(res.body.error.message).toContain(retired);
  });
});
