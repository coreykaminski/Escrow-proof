/**
 * Evaluator-for-hire (Part 10): a job on someone else's ERC-8183 contract names Proof Desk as
 * evaluator; the platform attaches it; Proof Desk settles with the standard complete/reject.
 * FakeChainGateway enforces the standard's rules; the real reference contract runs on anvil in
 * packages/chain/test/anvil.test.ts.
 */
import { type ExternalJob, FakeChainGateway } from "@proofdesk/chain";
import type { VerificationReport } from "@proofdesk/verifier";
import { type Address, getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

const BUDGET = 250_000_000; // 250 USDC
const OTHER_CONTRACT = getAddress("0x00000000000000000000000000000000000e8183");
const CLIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const PROVIDER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");

let h: Harness;
let chain: FakeChainGateway;
afterEach(async () => {
  await h?.close();
});

async function setup(verifier?: () => Promise<VerificationReport>) {
  h = await createHarness({
    chain: (now) => {
      chain = new FakeChainGateway(undefined, now);
      return chain;
    },
    ...(verifier ? { verifier } : {}),
  });
  const cfg = await chain.config();
  chain.externalTokens.set(OTHER_CONTRACT, cfg.token);
}

const A = () => h.keys.platformA;
const O = () => h.keys.ops;

async function approved(spec: Record<string, unknown> = {}) {
  const agr = (
    await h.call(A(), "POST", "/v1/agreements", {
      buyer_ref: "buyer_agent",
      seller_ref: "provider_agent",
      spec: specFixture({ amount: { value: BUDGET, currency: "usdc" }, ...spec }),
    })
  ).body;
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  return agr.id as string;
}

/** The buyer creates and funds a job on the other contract, as the terms say. */
async function buyerJob(id: string, over: Partial<ExternalJob> = {}) {
  const terms = (await h.call(A(), "GET", `/v1/agreements/${id}/external-job/terms`)).body;
  return chain.addExternalJob(OTHER_CONTRACT, {
    client: CLIENT,
    provider: PROVIDER,
    evaluator: terms.evaluator as Address,
    expiredAt: BigInt(terms.recommended_expired_at),
    description: `Translate the NDA. ${terms.description_must_contain}`,
    budget: BigInt(terms.budget),
    ...over,
  });
}

const attach = (id: string, job: { jobId: bigint }, contract: string = OTHER_CONTRACT) =>
  h.call(A(), "POST", `/v1/agreements/${id}/external-job`, {
    contract,
    job_id: job.jobId.toString(),
  });

async function decided(id: string, outcome: Record<string, unknown>) {
  await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
    artifacts: [{ name: "out.txt", media_type: "text/plain", content: "hecho" }],
  });
  await h.call(O(), "POST", `/v1/ops/agreements/${id}/start-verification`);
  return h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, { outcome, reason: "reviewed" });
}

describe("external ERC-8183 jobs", () => {
  it("issues the terms a buyer's job must meet", async () => {
    await setup();
    const id = await approved();
    const terms = (await h.call(A(), "GET", `/v1/agreements/${id}/external-job/terms`)).body;
    const cfg = await chain.config();
    expect(terms).toMatchObject({
      evaluator: cfg.evaluator,
      token: cfg.token,
      chain_id: cfg.chainId,
      budget: String(BUDGET),
      outcomes: ["complete", "reject"],
    });
    expect(terms.description_must_contain).toMatch(new RegExp(`^proofdesk:v1:${id}:[0-9a-f]{64}$`));
    expect(terms.recommended_expired_at).toBeGreaterThan(terms.min_expired_at);
  });

  it("attaches a matching job, then completes it once the provider has submitted", async () => {
    await setup();
    const id = await approved();
    const job = await buyerJob(id);
    const res = await attach(id, job);
    expect(res.status).toBe(201);
    expect(res.body.agreement).toMatchObject({
      status: "funded",
      hold: { rail: "onchain", ref: `erc8183:84532:${OTHER_CONTRACT}:${job.jobId}` },
    });
    expect(res.body.job).toMatchObject({
      kind: "external",
      contract: OTHER_CONTRACT,
      client: CLIENT,
    });
    // Idempotent for the same job.
    expect((await attach(id, job)).status).toBe(201);
    // The native funding flow is closed for this agreement.
    expect((await h.call(A(), "POST", `/v1/agreements/${id}/onchain-job`)).body.error.code).toBe(
      "already_funding",
    );

    expect((await decided(id, { kind: "release" })).status).toBe(200);
    h.clock.advance(80 * HOUR);
    const early = await h.call(O(), "POST", `/v1/ops/agreements/${id}/settle`, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("provider_not_submitted");

    chain.submitExternal(OTHER_CONTRACT, job.jobId);
    const settled = await h.call(O(), "POST", "/v1/ops/run-due");
    expect(settled.body.settled).toEqual([id]);
    expect(chain.externalCalls).toEqual([
      expect.objectContaining({ fn: "complete", contract: OTHER_CONTRACT, jobId: job.jobId }),
    ]);
    expect(chain.balances.get(PROVIDER)).toBe(BigInt(BUDGET));

    // The on-chain reason is the decision's ledger entry hash.
    const ledger = (await h.call(A(), "GET", `/v1/agreements/${id}/ledger`)).body.data;
    const decision = ledger.find((e: { type: string }) => e.type === "agreement.decide");
    expect(chain.externalCalls[0]?.reason).toBe(`0x${decision.entry_hash}`);
    const after = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    expect(after).toMatchObject({
      status: "settled",
      settlement: {
        standard: "erc8183",
        seller_payout: BUDGET,
        buyer_refund: 0,
        job_status: "completed",
      },
    });
    expect((await h.call(O(), "GET", "/v1/ops/ledger/verify")).body.ok).toBe(true);
  });

  it("rejects (refunds the client) without waiting for a submission", async () => {
    await setup();
    const id = await approved();
    const job = await buyerJob(id);
    await attach(id, job);
    await decided(id, { kind: "refund" });
    h.clock.advance(80 * HOUR);
    expect((await h.call(O(), "POST", "/v1/ops/run-due")).body.settled).toEqual([id]);
    expect(chain.externalCalls.map((c) => c.fn)).toEqual(["reject"]);
    expect(chain.balances.get(CLIENT)).toBe(BigInt(BUDGET));
  });

  it("refuses jobs that don't match the agreement, saying why", async () => {
    await setup();
    const id = await approved();
    const terms = (await h.call(A(), "GET", `/v1/agreements/${id}/external-job/terms`)).body;
    const bad = await buyerJob(id, {
      evaluator: CLIENT,
      budget: 1n,
      description: "no tag",
      expiredAt: BigInt(terms.min_expired_at) - 1n,
      hook: getAddress("0x000000000000000000000000000000000000beef"),
    });
    const res = await attach(id, bad);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("terms_mismatch");
    for (const why of ["evaluator", "budget", "description", "expire", "hook"]) {
      expect(res.body.error.message).toContain(why);
    }

    const otherToken = getAddress("0x000000000000000000000000000000000000dead");
    chain.externalTokens.set(OTHER_CONTRACT, otherToken);
    expect((await attach(id, await buyerJob(id))).body.error.message).toContain(otherToken);
    chain.externalTokens.delete(OTHER_CONTRACT);
    expect((await attach(id, await buyerJob(id))).body.error.message).toContain("paymentToken");

    const missing = await attach(id, { jobId: 999n });
    expect(missing.body.error.code).toBe("job_not_found");

    // Another agreement's job can't be attached here (the tag names the agreement).
    await setup();
    const one = await approved();
    const two = await approved();
    const forOne = await buyerJob(one);
    expect((await attach(two, forOne)).body.error.message).toContain("description");
    expect((await h.call(A(), "GET", `/v1/agreements/${two}`)).body.status).toBe("spec_approved");
  });

  it("only takes release or refund: partial decisions go to a human", async () => {
    const partialReport = {
      engine_version: "translation-v1/test",
      vertical: "translation",
      decision: {
        action: "decide",
        outcome: { kind: "partial", releasePercent: 70 },
        confidence: 0.95,
        reason: "one section missing",
      },
      criteria: [],
      findings: [],
      usage: { cost_usd: 0, calls: [] },
    } as unknown as VerificationReport;
    await setup(async () => partialReport);
    const agr = (
      await h.call(A(), "POST", "/v1/agreements", {
        buyer_ref: "buyer_agent",
        seller_ref: "provider_agent",
        spec: specFixture({ amount: { value: BUDGET, currency: "usdc" } }),
      })
    ).body;
    const withInputs = await h.call(A(), "PUT", `/v1/agreements/${agr.id}/inputs`, {
      inputs: [{ name: "nda.txt", media_type: "text/plain", content: "The NDA." }],
    });
    await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: withInputs.body.spec_hash,
    });
    const id = agr.id as string;
    expect((await attach(id, await buyerJob(id))).status).toBe(201);
    await h.call(A(), "POST", `/v1/agreements/${id}/deliveries`, {
      artifacts: [{ name: "out.txt", media_type: "text/plain", content: "hecho" }],
    });

    // The verifier proposes 70%: the job can't settle that, so a human gets the case.
    const verified = await h.call(O(), "POST", `/v1/ops/agreements/${id}/verify`);
    expect(verified.status).toBe(200);
    expect(verified.body.agreement.status).toBe("escalated");
    expect(verified.body.verification.action).toBe("escalate");

    const partial = await h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, {
      outcome: { kind: "partial", release_percent: 50 },
      reason: "half",
    });
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe("partial_unsupported");
    const release = await h.call(O(), "POST", `/v1/ops/agreements/${id}/decide`, {
      outcome: { kind: "release" },
      reason: "the missing section is minor",
    });
    expect(release.body.status).toBe("decided");
  });

  it("refunds a job attached after the delivery deadline", async () => {
    await setup();
    const id = await approved();
    const job = await buyerJob(id);
    h.clock.advance(30 * 24 * HOUR);
    const res = await attach(id, job);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("deadline_passed");
    expect(chain.externalCalls.map((c) => c.fn)).toEqual(["reject"]);
    expect(chain.balances.get(CLIENT)).toBe(BigInt(BUDGET));
  });

  it("records a job the client reclaimed after expiry", async () => {
    await setup();
    const id = await approved();
    const job = await buyerJob(id);
    await attach(id, job);
    h.clock.now = new Date(Number(job.expiredAt) * 1000 + 1000);
    chain.claimExternalRefund(OTHER_CONTRACT, job.jobId);
    await h.call(O(), "POST", "/v1/ops/run-due");
    const after = (await h.call(A(), "GET", `/v1/agreements/${id}/onchain-job`)).body;
    expect(after.status).toBe("expired");
  });

  it("publishes an evaluator listing for ERC-8183 ecosystems", async () => {
    await setup();
    const res = await h.call(null, "GET", "/.well-known/erc8183-evaluator.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.body).toMatchObject({
      object: "erc8183_evaluator",
      evaluator: (await chain.config()).evaluator,
      network: "base-sepolia",
      outcomes: ["complete", "reject"],
    });
    await h.close();
    h = await createHarness();
    expect((await h.call(null, "GET", "/.well-known/erc8183-evaluator.json")).status).toBe(404);
  });
});
