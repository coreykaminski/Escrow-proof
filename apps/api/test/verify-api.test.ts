/**
 * The Verify API: work checked against criteria with no payment held, billed per check, in live
 * mode too. A verifier outage leaves a job to retry, not a lost request.
 */
import { FakeGateway } from "@proofdesk/payments";
import { NodePermissionSandbox, SandboxUnavailableError, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

let outage = false;
async function setup() {
  outage = false;
  h = await createHarness({
    codeVerifier: async (input) => {
      if (outage) throw new SandboxUnavailableError("docker is down");
      return verifyCode(input, { sandbox: new NodePermissionSandbox(), timeoutMs: 5_000 });
    },
  });
}

const spec = {
  version: 1,
  title: "isEven(n)",
  request: "Write isEven(n) as an ES module.",
  vertical: "code",
  criteria: [
    {
      id: "tests-pass",
      description: "All acceptance tests pass",
      check: "deterministic",
      critical: true,
    },
  ],
};
const tests = {
  name: "tests/even.test.mjs",
  media_type: "text/javascript",
  content: `import test from "node:test";
import assert from "node:assert/strict";
import { isEven } from "../even.mjs";
test("[tests-pass] even", () => assert.equal(isEven(4), true));
test("[tests-pass] odd", () => assert.equal(isEven(7), false));
`,
};
const code = (src: string) => [{ name: "even.mjs", media_type: "text/javascript", content: src }];

describe("Verify API", () => {
  it("checks work in live mode with nothing held, bills the check, and closes the job", async () => {
    await setup();
    const live = h.keys.live;
    const res = await h.call(live, "POST", "/v1/verifications", {
      spec,
      inputs: [tests],
      deliverable: code("export const isEven = (n) => n % 2 === 0;"),
      metadata: { run: "ci-42" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "verification_job",
      livemode: true,
      status: "decided",
      outcome: { kind: "release" },
      metadata: { run: "ci-42" },
      verification: { action: "decide", engine_version: expect.stringMatching(/^code-v1/) },
    });
    const id = res.body.id;

    // Billed as a live verification; no conditional-payment fee, nothing held.
    const usage = (await h.call(live, "GET", "/v1/billing/usage?period=2026-10")).body;
    expect(usage.live.verification_fees).toBe(300);
    const agreement = (await h.call(live, "GET", `/v1/agreements/${id}`)).body;
    expect(agreement).toMatchObject({
      amount: { value: 0 },
      hold: { rail: "none" },
      appeal_window_hours: 0,
    });

    // No appeal window by default: the scheduler closes it, moving no money.
    h.clock.advance(HOUR);
    expect((await h.call(h.keys.ops, "POST", "/v1/ops/run-due")).body.settled).toContain(id);
    expect((await h.call(live, "GET", `/v1/verifications/${id}`)).body.status).toBe("settled");
    expect(
      (await h.call(live, "GET", "/v1/verifications")).body.data.map((j: { id: string }) => j.id),
    ).toEqual([id]);
    expect((await h.call(h.keys.platformA, "GET", `/v1/verifications/${id}`)).status).toBe(404);
    expect((await h.call(h.keys.ops, "GET", "/v1/ops/ledger/verify")).body.ok).toBe(true);
  });

  it("returns failing verdicts with evidence", async () => {
    await setup();
    const res = await h.call(h.keys.platformA, "POST", "/v1/verifications", {
      spec,
      inputs: [tests],
      deliverable: code("export const isEven = () => true;"),
    });
    expect(res.body.outcome).toEqual({ kind: "refund" });
    expect(res.body.verification.report.findings.map((f: { kind: string }) => f.kind)).toContain(
      "tests_failed",
    );
  });

  it("keeps the job through a verifier outage and finishes it on retry", async () => {
    await setup();
    outage = true;
    const res = await h.call(h.keys.platformA, "POST", "/v1/verifications", {
      spec,
      inputs: [tests],
      deliverable: code("export const isEven = (n) => n % 2 === 0;"),
    });
    expect(res.status).toBe(503);
    const id = res.body.error.details.verification_job_id;
    expect(id).toMatch(/^agr_/);
    expect((await h.call(h.keys.platformA, "GET", `/v1/verifications/${id}`)).body.status).toBe(
      "verifying",
    );
    outage = false;
    const retried = await h.call(h.keys.platformA, "POST", `/v1/verifications/${id}/retry`);
    expect(retried.body).toMatchObject({ status: "decided", outcome: { kind: "release" } });
  });

  it("validates the request before creating anything", async () => {
    await setup();
    const A = h.keys.platformA;
    const general = await h.call(A, "POST", "/v1/verifications", {
      spec: { ...spec, vertical: "general" },
      deliverable: code("x"),
    });
    expect(general.body.error.code).toBe("no_automated_verifier");
    const bad = await h.call(A, "POST", "/v1/verifications", {
      spec: { ...spec, criteria: [] },
      deliverable: code("x"),
    });
    expect(bad.status).toBe(400);
    expect((await h.call(A, "GET", "/v1/agreements")).body.data).toEqual([]);
  });

  it("zero-amount agreements can't be funded with real money", async () => {
    h = await createHarness({ payments: (now) => new FakeGateway({ now }) });
    const A = h.keys.platformA;
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: {
          ...spec,
          amount: { value: 0, currency: "usd" },
          delivery_due_at: "2026-10-20T00:00:00Z",
        },
      })
    ).body;
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
    const hold = await h.call(A, "POST", `/v1/agreements/${agr.id}/card-hold`, {
      payment_method: "pm_card_visa",
    });
    expect(hold.status).toBe(422);
    expect(hold.body.error.code).toBe("amount_required");
  });
});
