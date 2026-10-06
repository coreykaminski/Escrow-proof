import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

async function createAgreement(key = h.keys.platformA, spec = specFixture()) {
  const res = await h.call(key, "POST", "/v1/agreements", {
    buyer_ref: "user_buyer_1",
    seller_ref: "agent_translator_7",
    spec,
    metadata: { order: "ord_123" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

/** Drive an agreement (a new one unless given) to "delivered". */
async function toDelivered(existing?: { id: string; spec_hash: string }) {
  const agr = existing ?? (await createAgreement());
  const A = h.keys.platformA;
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, {
    rail: "test",
    hold_ref: "hold_test_1",
  });
  h.clock.advance(HOUR);
  const d = await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [
      { name: "nda_es.txt", media_type: "text/plain", content: "ACUERDO DE CONFIDENCIALIDAD…" },
    ],
  });
  expect(d.status).toBe(201);
  return agr.id as string;
}

async function toDecided(
  outcome: Record<string, unknown> = { kind: "release" },
  existing?: { id: string; spec_hash: string },
) {
  const id = await toDelivered(existing);
  const O = h.keys.ops;
  await h.call(O, "POST", `/v1/ops/agreements/${id}/start-verification`);
  const res = await h.call(O, "POST", `/v1/ops/agreements/${id}/decide`, {
    outcome,
    reason: "all criteria met",
    confidence: 0.96,
  });
  expect(res.status).toBe(200);
  return id;
}

describe("agreement lifecycle over HTTP", () => {
  it("runs create → approve → fund → deliver → verify → decide → settle, all on the ledger", async () => {
    const agr = await createAgreement();
    expect(agr).toMatchObject({
      object: "agreement",
      status: "draft",
      livemode: false,
      amount: { value: 18_000, currency: "usd" },
      delivery_due_at: "2026-10-10T12:00:00.000Z",
      metadata: { order: "ord_123" },
    });
    expect(agr.id).toMatch(/^agr_[0-9A-Z]{26}$/);
    expect(agr.spec_hash).toMatch(/^[0-9a-f]{64}$/);

    const id = await toDecided({ kind: "release" }, agr);
    const O = h.keys.ops;

    // Can't settle during the appeal window…
    const early = await h.call(O, "POST", `/v1/ops/agreements/${id}/settle`, {
      settlement_ref: "stl_1",
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("appeal_window_open");

    // …but can once it closes.
    h.clock.advance(72 * HOUR);
    const settled = await h.call(O, "POST", `/v1/ops/agreements/${id}/settle`, {
      settlement_ref: "stl_1",
    });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({
      status: "settled",
      outcome: { kind: "release" },
      settlement_ref: "stl_1",
    });

    const ledger = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}/ledger`);
    expect(ledger.body.data.map((e: { type: string }) => e.type)).toEqual([
      "agreement.created",
      "agreement.approve_spec",
      "agreement.fund",
      "agreement.deliver",
      "agreement.start_verification",
      "agreement.decide",
      "agreement.settle",
    ]);
    const decide = ledger.body.data[5];
    expect(decide.payload).toMatchObject({
      from: "verifying",
      to: "decided",
      decided_by: "human",
      confidence: 0.96,
      outcome: { kind: "release" },
      decision_id: expect.stringMatching(/^dec_/),
    });

    const verify = await h.call(O, "GET", "/v1/ops/ledger/verify");
    expect(verify.body).toMatchObject({ ok: true, count: 7 });
  });

  it("refuses approval of a spec the buyer didn't see", async () => {
    const agr = await createAgreement();
    // Platform edits the spec after the buyer looked at it.
    const edited = await h.call(h.keys.platformA, "PUT", `/v1/agreements/${agr.id}/spec`, {
      spec: specFixture({ amount: { value: 9_000, currency: "usd" } }),
    });
    expect(edited.body.spec_hash).not.toBe(agr.spec_hash);

    const res = await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("spec_hash_mismatch");
  });

  it("locks the spec after approval", async () => {
    const agr = await createAgreement();
    await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    const res = await h.call(h.keys.platformA, "PUT", `/v1/agreements/${agr.id}/spec`, {
      spec: specFixture(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("spec_locked");
  });

  it("stores content-addressed deliveries", async () => {
    const id = await toDelivered();
    const list = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}/deliveries`);
    const [d] = list.body.data;
    expect(d.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.artifacts[0]).toMatchObject({
      name: "nda_es.txt",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(d.artifacts[0].content).toBeUndefined();

    const full = await h.call(
      h.keys.platformA,
      "GET",
      `/v1/agreements/${id}/deliveries?include_content=true`,
    );
    expect(full.body.data[0].artifacts[0].content).toBe("ACUERDO DE CONFIDENCIALIDAD…");
  });

  it("refunds automatically when the seller misses the deadline", async () => {
    const agr = await createAgreement();
    const A = h.keys.platformA;
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "hold_1" });

    const tooEarly = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/miss-deadline`);
    expect(tooEarly.body.error.code).toBe("deadline_not_passed");

    h.clock.advance(5 * 24 * HOUR);
    const late = await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
      artifacts: [{ name: "x.txt", media_type: "text/plain", content: "late" }],
    });
    expect(late.body.error.code).toBe("deadline_passed");

    const res = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/miss-deadline`);
    expect(res.body).toMatchObject({ status: "decided", outcome: { kind: "refund" } });
  });

  it("can be cancelled before funding but not after", async () => {
    const a = await createAgreement();
    const ok = await h.call(h.keys.platformA, "POST", `/v1/agreements/${a.id}/cancel`, {
      actor: "seller",
      reason: "can't take this job",
    });
    expect(ok.body.status).toBe("cancelled");

    const id = await toDelivered();
    const no = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/cancel`, {
      actor: "buyer",
      reason: "never mind",
    });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe("invalid_transition");
  });

  it("lists the account's agreements, filterable by status", async () => {
    await createAgreement();
    await toDelivered();
    await createAgreement(h.keys.platformB);
    const all = await h.call(h.keys.platformA, "GET", "/v1/agreements");
    expect(all.body.data).toHaveLength(2);
    const delivered = await h.call(h.keys.platformA, "GET", "/v1/agreements?status=delivered");
    expect(delivered.body.data).toHaveLength(1);
  });
});

describe("disputes", () => {
  it("buyer disputes a release, ops overturns it, and it settles immediately", async () => {
    const id = await toDecided({ kind: "release" });
    h.clock.advance(HOUR);
    const opened = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/disputes`, {
      opened_by: "buyer",
      reason: "Clause 7 was omitted",
    });
    expect(opened.status).toBe(201);
    expect(opened.body.status).toBe("disputed");

    const resolved = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/resolve-dispute`, {
      outcome: { kind: "partial", release_percent: 40 },
      reason: "Clause 7 missing; rest accurate",
    });
    expect(resolved.body).toMatchObject({
      status: "decided",
      dispute_resolved: true,
      outcome: { kind: "partial", release_percent: 40 },
    });

    const again = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/disputes`, {
      opened_by: "seller",
      reason: "disagree",
    });
    expect(again.body.error.code).toBe("dispute_already_resolved");

    const settled = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/settle`, {
      settlement_ref: "stl_9",
    });
    expect(settled.body.status).toBe("settled");
  });

  it("seller can't dispute a release that went their way", async () => {
    const id = await toDecided({ kind: "release" });
    const res = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/disputes`, {
      opened_by: "seller",
      reason: "?",
    });
    expect(res.body.error.code).toBe("nothing_to_dispute");
  });

  it("closes after the appeal window", async () => {
    const id = await toDecided({ kind: "refund" });
    h.clock.advance(72 * HOUR);
    const res = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/disputes`, {
      opened_by: "seller",
      reason: "late",
    });
    expect(res.body.error.code).toBe("appeal_window_closed");
  });
});

describe("auth and isolation", () => {
  it("requires a valid API key", async () => {
    expect((await h.call(null, "GET", "/v1/agreements")).status).toBe(401);
    expect((await h.call("pd_test_nope", "GET", "/v1/agreements")).status).toBe(401);
    expect((await h.call("not-a-key", "GET", "/v1/agreements")).status).toBe(401);
  });

  it("hides other accounts' agreements (404, not 403)", async () => {
    const agr = await createAgreement(h.keys.platformA);
    const B = h.keys.platformB;
    expect((await h.call(B, "GET", `/v1/agreements/${agr.id}`)).status).toBe(404);
    expect((await h.call(B, "GET", `/v1/agreements/${agr.id}/ledger`)).status).toBe(404);
    const res = await h.call(B, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    expect(res.status).toBe(404);
  });

  it("keeps platform keys out of ops routes and ops keys out of platform routes", async () => {
    const agr = await createAgreement();
    const platformOnOps = await h.call(
      h.keys.platformA,
      "POST",
      `/v1/ops/agreements/${agr.id}/start-verification`,
    );
    expect(platformOnOps.status).toBe(403);
    expect(platformOnOps.body.error.code).toBe("insufficient_scope");
    expect((await h.call(h.keys.ops, "GET", "/v1/agreements")).status).toBe(403);
  });

  it("won't fund a live agreement with the test rail", async () => {
    const agr = await createAgreement(h.keys.live);
    expect(agr.livemode).toBe(true);
    await h.call(h.keys.live, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    const res = await h.call(h.keys.live, "POST", `/v1/agreements/${agr.id}/fund`, {
      rail: "test",
      hold_ref: "h",
    });
    expect(res.body.error.code).toBe("test_rail_in_livemode");
  });
});

describe("validation and errors", () => {
  it("returns field-level validation errors", async () => {
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture({ amount: { value: -5, currency: "USD" } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["spec.amount.value", "spec.amount.currency"]));
  });

  it("rejects malformed JSON", async () => {
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("returns JSON 404s for unknown routes and agreements", async () => {
    expect(
      (await h.call(h.keys.platformA, "GET", "/v1/agreements/agr_missing")).body.error.code,
    ).toBe("not_found");
    expect((await h.call(null, "GET", "/nope")).body.error.code).toBe("route_not_found");
  });
});

describe("idempotency", () => {
  const body = () => ({ buyer_ref: "b", seller_ref: "s", spec: specFixture() });

  it("replays the original response for a retried request", async () => {
    const headers = { "Idempotency-Key": "create-1" };
    const first = await h.call(h.keys.platformA, "POST", "/v1/agreements", body(), headers);
    const second = await h.call(h.keys.platformA, "POST", "/v1/agreements", body(), headers);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await h.call(h.keys.platformA, "GET", "/v1/agreements")).body.data).toHaveLength(1);
  });

  it("rejects reusing a key for a different request", async () => {
    const headers = { "Idempotency-Key": "create-2" };
    await h.call(h.keys.platformA, "POST", "/v1/agreements", body(), headers);
    const res = await h.call(
      h.keys.platformA,
      "POST",
      "/v1/agreements",
      { ...body(), buyer_ref: "someone-else" },
      headers,
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
  });

  it("scopes keys per account", async () => {
    const headers = { "Idempotency-Key": "shared" };
    const a = await h.call(h.keys.platformA, "POST", "/v1/agreements", body(), headers);
    const b = await h.call(h.keys.platformB, "POST", "/v1/agreements", body(), headers);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("replays error responses too, so a retry can't double-apply a transition", async () => {
    const id = await toDecided();
    const headers = { "Idempotency-Key": "settle-early" };
    const first = await h.call(
      h.keys.ops,
      "POST",
      `/v1/ops/agreements/${id}/settle`,
      { settlement_ref: "s" },
      headers,
    );
    h.clock.advance(100 * HOUR);
    const retry = await h.call(
      h.keys.ops,
      "POST",
      `/v1/ops/agreements/${id}/settle`,
      { settlement_ref: "s" },
      headers,
    );
    expect(first.status).toBe(409);
    expect(retry.status).toBe(409);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
  });
});
