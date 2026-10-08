/**
 * Part 6: dashboard + human review. "Done when: a dispute is resolved end to end; the verdict
 * report is shareable."
 */

import { FakeGateway } from "@proofdesk/payments";
import { ANNOTATOR_MODEL, type StructuredCaller, verifyTranslation } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createAccountWithKey } from "../src/accounts.ts";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const SOURCE = "The Client shall pay a monthly fee of $4,500.00 within 30 days of each invoice.";
const TARGET =
  "El Cliente pagará una tarifa mensual de 4.500,00 $ dentro de los 30 días siguientes a cada factura.";

/** Annotator finds nothing but the judge fails meaning-accurate → the verifier escalates. */
const disagreeing: StructuredCaller = {
  async call<S extends z.ZodType>(p: { model: string; user: string }) {
    const ids = [...p.user.matchAll(/^- ([a-z0-9-]+)/gm)].map((m) => m[1] as string);
    const output =
      p.model === ANNOTATOR_MODEL
        ? { errors: [], injection_detected: false }
        : {
            criteria: ids.map((id) => ({
              criterion_id: id,
              verdict: id === "meaning-accurate" ? "fail" : "pass",
              confidence: "high",
              evidence:
                id === "meaning-accurate"
                  ? [{ source_quote: "shall pay", target_quote: "pagará" }]
                  : [],
              reason: id === "meaning-accurate" ? "obligation may be weakened" : "ok",
            })),
          };
    return {
      output: output as z.infer<S>,
      model: p.model,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  },
};

const spec = () =>
  specFixture({
    criteria: [
      {
        id: "values-preserved",
        description: "Every number and date matches",
        check: "deterministic",
        critical: true,
      },
      {
        id: "meaning-accurate",
        description: "No change in meaning",
        check: "domain",
        critical: true,
      },
    ],
  });

/** Browser-ish requests: cookies, form posts, no redirect following. */
async function browse(
  method: string,
  path: string,
  opts: { cookie?: string; form?: Record<string, string> } = {},
) {
  const res = await h.fetch(`http://proofdesk.test${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(opts.form ? { body: new URLSearchParams(opts.form).toString() } : {}),
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    setCookie: res.headers.get("set-cookie"),
    html: await res.text(),
  };
}

async function signIn(apiKey: string) {
  const res = await browse("POST", "/dashboard/login", { form: { api_key: apiKey } });
  expect(res.status).toBe(302);
  const cookie = (res.setCookie ?? "").split(";")[0] as string;
  const page = await browse("GET", "/dashboard", { cookie });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.html)?.[1] ?? (await csrfFrom(cookie));
  return { cookie, csrf };
}
/** The CSRF token appears on pages with forms; the sign-out form is on every page. */
async function csrfFrom(cookie: string) {
  const page = await browse("GET", "/dashboard/reviewers", { cookie });
  return /name="csrf" value="([^"]+)"/.exec(page.html)?.[1] ?? "";
}

async function deliveredTranslation(deliverable = TARGET) {
  const A = h.keys.platformA;
  const agr = (
    await h.call(A, "POST", "/v1/agreements", {
      buyer_ref: "buyer_1",
      seller_ref: "seller_1",
      spec: spec(),
    })
  ).body;
  const withInput = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
    inputs: [{ name: "contract_en.txt", media_type: "text/plain", content: SOURCE }],
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInput.body.spec_hash,
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h1" });
  h.clock.advance(HOUR);
  await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [{ name: "contrato_es.txt", media_type: "text/plain", content: deliverable }],
  });
  return agr.id as string;
}

async function reviewerSession(name = "Reviewer Jane") {
  const reviewer = await createAccountWithKey(h.handle.db, { name, scopes: ["ops"] });
  return signIn(reviewer.apiKey);
}

describe("sign-in", () => {
  it("exchanges a valid API key for an HttpOnly session and rejects bad keys", async () => {
    h = await createHarness();
    expect((await browse("GET", "/dashboard")).location).toBe("/dashboard/login");
    const bad = await browse("POST", "/dashboard/login", { form: { api_key: "pd_test_nope" } });
    expect(bad.status).toBe(401);
    const ok = await browse("POST", "/dashboard/login", { form: { api_key: h.keys.platformA } });
    expect(ok.setCookie).toMatch(/pd_session=.+HttpOnly/i);
    expect(ok.setCookie).toMatch(/SameSite=Lax/i);
  });

  it("signs out", async () => {
    h = await createHarness();
    const s = await signIn(h.keys.platformA);
    await browse("POST", "/dashboard/logout", { cookie: s.cookie, form: { csrf: s.csrf } });
    expect((await browse("GET", "/dashboard", { cookie: s.cookie })).location).toBe(
      "/dashboard/login",
    );
  });
});

describe("platform views", () => {
  it("lists only the account's own agreements and hides others' cases", async () => {
    h = await createHarness();
    const mine = await deliveredTranslation();
    const other = (
      await h.call(h.keys.platformB, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: spec(),
      })
    ).body;
    const s = await signIn(h.keys.platformA);
    const list = await browse("GET", "/dashboard", { cookie: s.cookie });
    expect(list.html).toContain(mine);
    expect(list.html).not.toContain(other.id);
    expect(
      (await browse("GET", `/dashboard/agreements/${other.id}`, { cookie: s.cookie })).status,
    ).toBe(404);
    const filtered = await browse("GET", "/dashboard?status=settled", { cookie: s.cookie });
    expect(filtered.html).not.toContain(mine);
  });

  it("escapes deliverable content (it's untrusted)", async () => {
    h = await createHarness();
    const id = await deliveredTranslation(
      `${TARGET}\n\n<script>alert("x")</script><img src=x onerror=alert(1)>`,
    );
    const s = await signIn(h.keys.platformA);
    const page = await browse("GET", `/dashboard/agreements/${id}`, { cookie: s.cookie });
    expect(page.html).not.toContain('<script>alert("x")</script>');
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).toContain("&lt;script&gt;");
  });
});

describe("human review (Part 6 done-when)", () => {
  it("escalation → review queue → reviewer decides on the dashboard", async () => {
    h = await createHarness({
      verifier: (input) => verifyTranslation(input, { caller: disagreeing }),
    });
    const id = await deliveredTranslation();
    const verified = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/verify`);
    expect(verified.body.agreement.status).toBe("escalated");

    const r = await reviewerSession();
    const queue = await browse("GET", "/dashboard/review", { cookie: r.cookie });
    expect(queue.html).toContain(id);
    expect(queue.html).toContain("disagree");

    const casePage = await browse("GET", `/dashboard/agreements/${id}`, { cookie: r.cookie });
    expect(casePage.html).toContain("obligation may be weakened"); // the judge's evidence
    expect(casePage.html).toContain(SOURCE.slice(0, 30)); // documents side by side

    const decided = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: r.cookie,
      form: {
        csrf: r.csrf,
        outcome: "release",
        reason: "Checked clause 1: 'pagará' preserves 'shall pay'.",
      },
    });
    expect(decided.html).toContain("Decision recorded.");
    const agr = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}`);
    expect(agr.body).toMatchObject({ status: "decided", outcome: { kind: "release" } });
    const ledger = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}/ledger`);
    expect(ledger.body.data.at(-1).payload).toMatchObject({
      decided_by: "human",
      actor: { role: "ops" },
    });
    expect((await browse("GET", "/dashboard/review", { cookie: r.cookie })).html).not.toContain(id);
  });

  it("a buyer's dispute is resolved by a reviewer and then settles", async () => {
    h = await createHarness();
    const id = await deliveredTranslation();
    await h.call(h.keys.platformA, "POST", `/v1/test_helpers/agreements/${id}/decide`, {
      outcome: { kind: "release" },
    });
    const dispute = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/disputes`, {
      opened_by: "buyer",
      reason: "The payment deadline was changed in clause 1.",
    });
    expect(dispute.body.status).toBe("disputed");

    const r = await reviewerSession();
    const queue = await browse("GET", "/dashboard/review", { cookie: r.cookie });
    expect(queue.html).toContain("Dispute by buyer");

    const resolved = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: r.cookie,
      form: {
        csrf: r.csrf,
        outcome: "partial",
        release_percent: "50",
        reason: "Deadline wording ambiguous; split.",
      },
    });
    expect(resolved.html).toContain("Dispute resolved");
    const after = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}`);
    expect(after.body).toMatchObject({
      status: "decided",
      dispute_resolved: true,
      outcome: { kind: "partial", release_percent: 50 },
    });

    // A resolved dispute is final, so it settles on the next scheduler tick.
    const tick = await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
    expect(tick.body.settled).toContain(id);

    const stats = await browse("GET", "/dashboard/reviewers", { cookie: r.cookie });
    expect(stats.html).toContain("Reviewer Jane");
  });

  it("validates the decision form and refuses platforms and forged posts", async () => {
    h = await createHarness({
      verifier: (input) => verifyTranslation(input, { caller: disagreeing }),
    });
    const id = await deliveredTranslation();
    await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/verify`);
    const r = await reviewerSession();
    const noReason = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: r.cookie,
      form: { csrf: r.csrf, outcome: "release", reason: "" },
    });
    expect(noReason.status).toBe(400);
    const badPercent = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: r.cookie,
      form: { csrf: r.csrf, outcome: "partial", release_percent: "150", reason: "x" },
    });
    expect(badPercent.status).toBe(400);
    const forged = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: r.cookie,
      form: { outcome: "release", reason: "x" },
    });
    expect(forged.status).toBe(403);
    const platform = await signIn(h.keys.platformA);
    const asPlatform = await browse("POST", `/dashboard/agreements/${id}/decision`, {
      cookie: platform.cookie,
      form: { csrf: platform.csrf, outcome: "release", reason: "x" },
    });
    expect(asPlatform.status).toBe(403);
  });
});

describe("shareable verdict report", () => {
  it("shows verdicts and proof but not the documents, and links expire", async () => {
    h = await createHarness();
    const id = await deliveredTranslation();
    await h.call(h.keys.platformA, "POST", `/v1/test_helpers/agreements/${id}/decide`, {
      outcome: { kind: "release" },
    });
    const link = await h.call(h.keys.platformA, "POST", `/v1/agreements/${id}/report-links`, {
      expires_in_days: 1,
    });
    expect(link.status).toBe(201);
    const path = new URL(link.body.url).pathname;

    const report = await browse("GET", path);
    expect(report.status).toBe(200);
    expect(report.html).toContain("hash chain intact");
    expect(report.html).toContain("values-preserved");
    const agr = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}`);
    expect(report.html).toContain(agr.body.spec_hash);
    expect(report.html).not.toContain("4.500,00"); // deliverable content stays private
    expect(report.html).not.toContain("monthly fee"); // so does the source

    h.clock.advance(25 * HOUR);
    expect((await browse("GET", path)).status).toBe(404);
    expect((await browse("GET", "/r/not-a-real-token-xxxxxxxx")).status).toBe(404);
  });

  it("can be created from the dashboard too", async () => {
    h = await createHarness();
    const id = await deliveredTranslation();
    const s = await signIn(h.keys.platformA);
    const page = await browse("POST", `/dashboard/agreements/${id}/report-link`, {
      cookie: s.cookie,
      form: { csrf: s.csrf },
    });
    const url = /href="(http[^"]+\/r\/[^"]+)"/.exec(page.html)?.[1];
    expect(url).toBeDefined();
    expect((await browse("GET", new URL(url as string).pathname)).status).toBe(200);
  });
});

describe("hosted card page", () => {
  it("lets the buyer authorize the card, and funds the agreement on return", async () => {
    let gw!: FakeGateway;
    h = await createHarness({
      stripePublishableKey: "pk_test_123",
      payments: (now) => {
        gw = new FakeGateway({ now, webhookSecret: "whsec" });
        return gw;
      },
    });
    const A = h.keys.platformA;
    const onboarding = await h.call(A, "POST", "/v1/sellers/seller_1/onboarding", {
      email: "s@example.com",
    });
    gw.completeOnboarding(onboarding.body.seller.stripe_account_id);
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "seller_1",
        spec: spec(),
      })
    ).body;
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });

    const link = await h.call(A, "POST", `/v1/agreements/${agr.id}/payment-links`, {});
    expect(link.status).toBe(201);
    const path = new URL(link.body.url).pathname;
    const page = await browse("GET", path);
    expect(page.html).toContain('data-pk="pk_test_123"');
    expect(page.html).toMatch(/data-secret="pi_[^"]+_secret"/);
    expect(page.html).toContain("authorized, not charged");

    // The buyer confirms with Stripe.js; Stripe sends them back to the same page.
    const pi = (await h.call(A, "GET", `/v1/agreements/${agr.id}/hold`)).body.payment_intent_id;
    gw.confirm(pi);
    const back = await browse("GET", path);
    expect(back.html).toContain("Payment authorized");
    expect((await h.call(A, "GET", `/v1/agreements/${agr.id}`)).body.status).toBe("funded");
    expect((await browse("GET", "/pay/assets/pay.js")).html).toContain("confirmPayment");
  });
});
