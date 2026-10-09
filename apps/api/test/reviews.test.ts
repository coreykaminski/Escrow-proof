/**
 * Shadow mode for pilots (MASTER_PLAN §8, test layer 7): every automatic decision waits for a
 * human to confirm or override it, nothing settles unreviewed, and disagreements come out as
 * golden-set candidates.
 */
import { schema } from "@proofdesk/db";
import { FakeGateway } from "@proofdesk/payments";
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
let gw: FakeGateway;
afterEach(async () => {
  await h?.close();
});

async function setup(rates?: { currency: string; decision: number; disputeResolution: number }) {
  h = await createHarness({
    payments: (now) => {
      gw = new FakeGateway({ now });
      return gw;
    },
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
    ...(rates ? { reviewerRates: rates } : {}),
  });
}

const A = () => h.keys.platformA;
const O = () => h.keys.ops;

async function accountId(key: string) {
  const agr = (
    await h.call(key, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    })
  ).body;
  const [row] = await h.handle.db
    .select({ accountId: schema.agreements.accountId })
    .from(schema.agreements)
    .where(eq(schema.agreements.id, agr.id));
  return row?.accountId as string;
}

const SPEC = specFixture({
  title: "f() returns 1",
  vertical: "code",
  appeal_window_hours: 24,
  criteria: [
    { id: "tests-pass", description: "Tests pass", check: "deterministic", critical: true },
  ],
});
const TESTS = {
  name: "t/a.test.mjs",
  media_type: "text/javascript",
  content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[tests-pass] f", () => { if (f() !== 1) throw new Error("no"); });\n`,
};

/** A code job that passes its tests, verified automatically. */
async function autoDecided(code = "export const f = () => 1;") {
  const agr = (
    await h.call(A(), "POST", "/v1/agreements", { buyer_ref: "b", seller_ref: "s", spec: SPEC })
  ).body;
  const withInputs = (
    await h.call(A(), "PUT", `/v1/agreements/${agr.id}/inputs`, { inputs: [TESTS] })
  ).body;
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInputs.spec_hash,
  });
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
  await h.call(A(), "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [{ name: "f.mjs", media_type: "text/javascript", content: code }],
  });
  const res = await h.call(O(), "POST", `/v1/ops/agreements/${agr.id}/verify`);
  expect(res.status).toBe(200);
  return res.body.agreement;
}

async function shadow(on = true) {
  const id = await accountId(A());
  const res = await h.call(O(), "PUT", `/v1/ops/accounts/${id}/shadow-mode`, { enabled: on });
  expect(res.body).toMatchObject({ shadow_mode: on });
}

describe("shadow mode", () => {
  it("holds automatic decisions until a reviewer confirms; nothing settles before", async () => {
    await setup();
    await shadow();
    const agr = await autoDecided();
    expect(agr).toMatchObject({
      status: "decided",
      outcome: { kind: "release" },
      review_pending: true,
    });

    const pending = (await h.call(O(), "GET", "/v1/ops/reviews/pending")).body.data;
    expect(pending.map((p: { agreement: { id: string } }) => p.agreement.id)).toEqual([agr.id]);

    // Past the appeal window, the scheduler still won't settle it, and ops can't force it.
    h.clock.advance(48 * HOUR);
    expect((await h.call(O(), "POST", "/v1/ops/run-due")).body.settled).toEqual([]);
    const forced = await h.call(O(), "POST", `/v1/ops/agreements/${agr.id}/settle`, {
      force: true,
      settlement_ref: "manual",
    });
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe("review_pending");

    const reviewed = await h.call(O(), "POST", `/v1/ops/agreements/${agr.id}/review`, {
      reason: "tests are meaningful; output correct",
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.agreement).toMatchObject({
      review_pending: false,
      decided_at: agr.decided_at,
    });
    expect(reviewed.body.review).toMatchObject({
      agreed: true,
      auto_outcome: { kind: "release" },
      reviewed_outcome: { kind: "release" },
      override_decision_id: null,
    });
    expect((await h.call(O(), "GET", "/v1/ops/reviews/pending")).body.data).toEqual([]);
    expect((await h.call(O(), "POST", "/v1/ops/run-due")).body.settled).toEqual([agr.id]);

    const ledger = (await h.call(A(), "GET", `/v1/agreements/${agr.id}/ledger`)).body.data;
    const types = ledger.map((e: { type: string }) => e.type);
    expect(types).toContain("agreement.review");
    expect(types.indexOf("agreement.review")).toBeLessThan(types.indexOf("agreement.settle"));
    expect((await h.call(O(), "GET", "/v1/ops/ledger/verify")).body.ok).toBe(true);
  });

  it("an override replaces the outcome, restarts the appeal window and becomes a golden candidate", async () => {
    await setup();
    await shadow();
    // Passes the buyer's (weak) test but hard-codes the answer: the reviewer refuses it.
    const agr = await autoDecided("export const f = () => 1; // TODO real implementation");
    h.clock.advance(2 * HOUR);
    const res = await h.call(O(), "POST", `/v1/ops/agreements/${agr.id}/review`, {
      outcome: { kind: "refund" },
      reason: "hard-coded; does not implement the requested function",
    });
    expect(res.body.agreement).toMatchObject({
      outcome: { kind: "refund" },
      review_pending: false,
      decided_at: h.clock.now.toISOString(),
    });
    expect(res.body.review).toMatchObject({ agreed: false, reviewed_outcome: { kind: "refund" } });
    expect(res.body.review.override_decision_id).toMatch(/^dec_/);

    // The seller lost on review, so the seller may now appeal.
    const appeal = await h.call(A(), "POST", `/v1/agreements/${agr.id}/disputes`, {
      opened_by: "seller",
      reason: "it works",
    });
    expect(appeal.status).toBe(201);

    const stats = (await h.call(O(), "GET", "/v1/ops/reviews/stats")).body;
    expect(stats.verticals).toEqual([
      expect.objectContaining({
        vertical: "code",
        reviewed: 1,
        agreed: 0,
        false_release: 1,
        false_refund: 0,
      }),
    ]);
    expect((await h.call(O(), "GET", "/v1/ops/reviews?agreed=false")).body.data).toHaveLength(1);
    expect((await h.call(O(), "GET", "/v1/ops/reviews?agreed=true")).body.data).toHaveLength(0);

    const ndjson = await h.fetch("http://x/v1/ops/reviews/golden-candidates", {
      headers: { Authorization: `Bearer ${O()}` },
    });
    expect(ndjson.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await ndjson.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({
        source: "shadow_review",
        vertical: "code",
        inputs: [expect.objectContaining({ name: "t/a.test.mjs" })],
        deliverable: [
          expect.objectContaining({ name: "f.mjs", content: expect.stringContaining("TODO") }),
        ],
        label: expect.objectContaining({ outcome: { kind: "refund" } }),
        verifier: expect.objectContaining({
          outcome: { kind: "release" },
          engine_version: expect.stringMatching(/^code-v1/),
        }),
      }),
    ]);
    // Platforms can't read reviews or candidates.
    expect((await h.call(A(), "GET", "/v1/ops/reviews")).status).toBe(403);
  });

  it("leaves other accounts alone, and can be switched off", async () => {
    await setup();
    const normal = await autoDecided();
    expect(normal.review_pending).toBe(false);
    const res = await h.call(O(), "POST", `/v1/ops/agreements/${normal.id}/review`, {
      reason: "x",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_review_pending");

    await shadow(true);
    expect((await autoDecided()).review_pending).toBe(true);
    await shadow(false);
    expect((await autoDecided()).review_pending).toBe(false);
  });

  it("is reviewable from the dashboard", async () => {
    await setup();
    await shadow();
    const agr = await autoDecided();
    const login = await h.fetch("http://x/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `api_key=${encodeURIComponent(O())}`,
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const queue = await (
      await h.fetch("http://x/dashboard/review", { headers: { cookie } })
    ).text();
    expect(queue).toContain(agr.id);
    expect(queue).toContain("Shadow review of an automatic release");

    const page = await (
      await h.fetch(`http://x/dashboard/agreements/${agr.id}`, { headers: { cookie } })
    ).text();
    expect(page).toContain("Confirm the automatic decision");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const post = await h.fetch(`http://x/dashboard/agreements/${agr.id}/decision`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, outcome: "confirm", reason: "looks right" }).toString(),
    });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Automatic decision confirmed");
    const after = (await h.call(O(), "GET", `/v1/ops/agreements/${agr.id}`)).body;
    expect(after.review_pending).toBe(false);
  });

  it("pays reviewers for confirmations and overrides at the configured rates", async () => {
    await setup({ currency: "cad", decision: 1_000, disputeResolution: 3_000 });
    await shadow();
    const a = await autoDecided();
    const b = await autoDecided();
    await h.call(O(), "POST", `/v1/ops/agreements/${a.id}/review`, { reason: "ok" });
    await h.call(O(), "POST", `/v1/ops/agreements/${b.id}/review`, {
      outcome: { kind: "partial", release_percent: 50 },
      reason: "half done",
    });
    const onboard = await h.call(O(), "POST", "/v1/ops/reviewers/me/onboarding", {
      email: "reviewer@proofdesk.example",
    });
    gw.completeOnboarding(onboard.body.payout_account.stripe_account_id);
    h.clock.now = new Date("2026-11-01T00:00:05Z");
    const paid = (
      await h.call(O(), "POST", "/v1/ops/billing/reviewer-payouts", { period: "2026-10" })
    ).body;
    // Two reviews (the override isn't counted again as a decision), at CAD $10 each.
    expect(paid.paid).toEqual([expect.objectContaining({ amount: 2_000 })]);
    expect(gw.payouts).toEqual([expect.objectContaining({ amount: 2_000, currency: "cad" })]);
  });
});
