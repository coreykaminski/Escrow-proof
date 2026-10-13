/**
 * TaskHub: a tiny marketplace that pays sellers only when Proof Desk says the work passed.
 * It's the reference integration: everything a platform does is here, in one file, using only
 * the public SDK. Copy the parts you need.
 *
 *   1. Buyer posts a job      → pd.agreements.createFromTemplate (checkable criteria, no AI)
 *   2. Buyer approves checks  → pd.agreements.approveSpec (consent to the exact spec hash)
 *   3. Buyer pays             → sandbox: pd.agreements.fund; live: createCardHold / createPaymentLink
 *   4. Seller delivers        → pd.agreements.deliver
 *   5. Proof Desk verifies    → in production Proof Desk runs it; the sandbox triggers it here
 *   6. Status updates arrive  → POST /webhooks/proofdesk, verified with verifyWebhook
 *   7. Verdict on the page    → the embeddable widget from createReportLink
 *
 * Run it against a local Proof Desk (docs/integrations/marketplace-guide.md):
 *   PROOFDESK_API_KEY=pd_test_… npx tsx examples/marketplace/server.ts
 */
import { serve } from "@hono/node-server";
import { type Agreement, ProofDesk, ProofDeskError, verifyWebhook } from "@proofdesk/sdk";
import { Hono } from "hono";
import { html, raw } from "hono/html";

const PORT = Number(process.env.PORT ?? 3000);
const SELF = process.env.TASKHUB_URL ?? `http://localhost:${PORT}`;
const pd = new ProofDesk({
  apiKey: process.env.PROOFDESK_API_KEY ?? "",
  baseUrl: process.env.PROOFDESK_BASE_URL ?? "http://localhost:8787",
});

/** TaskHub's own records. A real marketplace keeps these in its database. */
interface Job {
  agreementId: string;
  buyer: string;
  seller: string;
  status: Agreement["status"];
  outcome: Agreement["outcome"];
  embedHtml?: string;
}
const jobs = new Map<string, Job>();
let webhookSecret = process.env.PROOFDESK_WEBHOOK_SECRET ?? "";

const app = new Hono();

const page = (title: string, body: unknown) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title} · TaskHub</title>
      <style>
        body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222}
        a{color:#2a5bd7}label{display:block;margin:10px 0 4px;font-weight:600}
        input,select,textarea{width:100%;font:inherit;padding:7px;border:1px solid #ccc;border-radius:6px}
        textarea{min-height:120px;font-family:ui-monospace,monospace;font-size:13px}
        button{margin-top:12px;padding:8px 16px;font:inherit;border-radius:6px;border:0;background:#2a5bd7;color:#fff;cursor:pointer}
        .card{border:1px solid #ddd;border-radius:8px;padding:14px;margin:12px 0}.muted{color:#777}
        li{margin:4px 0}
      </style>
    </head>
    <body>
      <p><a href="/">TaskHub</a> <span class="muted">· pay only when it's done right</span></p>
      ${body}
    </body>
  </html>`;

/** Keeps TaskHub's record in step with Proof Desk (webhooks do this too; this is the fallback). */
async function refresh(job: Job): Promise<Job> {
  const a = await pd.agreements.retrieve(job.agreementId);
  job.status = a.status;
  job.outcome = a.outcome;
  if (a.outcome && !job.embedHtml) {
    job.embedHtml = (
      await pd.agreements.createReportLink(a.id, { expires_in_days: 90 })
    ).embed.html;
  }
  return job;
}

app.get("/", (c) =>
  c.html(
    page(
      "Jobs",
      html`<h1>Jobs</h1>
        <ul>
          ${[...jobs.values()].map(
            (j) =>
              html`<li><a href="/jobs/${j.agreementId}">${j.agreementId}</a> · ${j.status}
                ${j.outcome ? html`· <strong>${j.outcome.kind}</strong>` : ""}</li>`,
          )}
        </ul>
        <div class="card">
          <h2>Post a job</h2>
          <form method="post" action="/jobs">
            <label>What do you need?</label>
            <input name="task" required value="Write isEven(n) as an ES module (even.mjs)." />
            <label>Price (USD)</label>
            <input name="price" type="number" min="1" value="40" />
            <label>Acceptance tests (the seller must make these pass)</label>
            <textarea name="tests">${DEFAULT_TESTS}</textarea>
            <button>Post job</button>
          </form>
        </div>`,
    ),
  ),
);

// 1. Post a job: Proof Desk turns it into checkable acceptance criteria.
app.post("/jobs", async (c) => {
  const form = await c.req.parseBody();
  let agreement = await pd.agreements.createFromTemplate({
    buyer_ref: "buyer_alice",
    seller_ref: "seller_bob_agent",
    template: "code.acceptance-tests",
    params: { task: String(form.task) },
    amount: { value: Math.round(Number(form.price) * 100), currency: "usd" },
    delivery_due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    appeal_window_hours: 0,
  });
  // The buyer's tests are an input, locked in by the spec hash the buyer approves next.
  agreement = await pd.agreements.replaceInputs(agreement.id, [
    { name: "tests/job.test.mjs", media_type: "text/javascript", content: String(form.tests) },
  ]);
  jobs.set(agreement.id, {
    agreementId: agreement.id,
    buyer: "buyer_alice",
    seller: "seller_bob_agent",
    status: agreement.status,
    outcome: null,
  });
  return c.redirect(`/jobs/${agreement.id}`);
});

app.get("/jobs/:id", async (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.notFound();
  await refresh(job);
  const a = await pd.agreements.retrieve(job.agreementId);
  return c.html(
    page(
      a.spec.title,
      html`<h1>${a.spec.title}</h1>
        <p class="muted">${a.id} · ${a.status} · $${(a.amount.value / 100).toFixed(2)}</p>
        ${
          a.status === "draft"
            ? html`<div class="card">
              <h2>Buyer: approve the checks</h2>
              <p>The seller is paid only if all of these pass:</p>
              <ul>${a.spec.criteria.map((cr) => html`<li>${cr.description}</li>`)}</ul>
              <form method="post" action="/jobs/${a.id}/approve">
                <input type="hidden" name="spec_hash" value="${a.spec_hash}" />
                <button>Approve and pay $${(a.amount.value / 100).toFixed(2)}</button>
              </form>
            </div>`
            : ""
        }
        ${
          a.status === "funded"
            ? html`<div class="card">
              <h2>Seller: deliver your work</h2>
              <p class="muted">The money is held. You're paid the moment the checks pass.</p>
              <form method="post" action="/jobs/${a.id}/deliver">
                <label>even.mjs</label>
                <textarea name="code">export const isEven = (n) => n % 2 === 0;</textarea>
                <button>Deliver</button>
              </form>
            </div>`
            : ""
        }
        ${
          job.embedHtml
            ? html`<h2>Verdict</h2>
              ${raw(job.embedHtml)}`
            : a.status === "escalated"
              ? html`<p>A Proof Desk reviewer is looking at this one.</p>`
              : ""
        }`,
    ),
  );
});

// 2–3. The buyer consents to the exact checks (by hash), then pays.
app.post("/jobs/:id/approve", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  await pd.agreements.approveSpec(id, String(form.spec_hash));
  // Sandbox: a test hold. Live: pd.agreements.createCardHold(id, { payment_method }) or a hosted
  // page from pd.agreements.createPaymentLink(id) (card or USDC).
  await pd.agreements.fund(id, { rail: "test", hold_ref: `taskhub_${Date.now()}` });
  return c.redirect(`/jobs/${id}`);
});

// 4–5. The seller delivers; Proof Desk runs the buyer's tests in its sandbox.
app.post("/jobs/:id/deliver", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  await pd.agreements.deliver(id, [
    { name: "even.mjs", media_type: "text/javascript", content: String(form.code) },
  ]);
  // In production Proof Desk verifies every delivery itself. The sandbox lets you trigger it.
  try {
    await pd.testHelpers.verify(id);
    await pd.testHelpers.settle(id);
  } catch (err) {
    if (!(err instanceof ProofDeskError)) throw err;
    console.warn(`verify: ${err.code} ${err.message}`);
  }
  return c.redirect(`/jobs/${id}`);
});

// 6. Proof Desk's events: verify the signature on the raw body, then update TaskHub's records.
app.post("/webhooks/proofdesk", async (c) => {
  const raw = await c.req.text();
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(raw, c.req.header("Proofdesk-Signature") ?? "", webhookSecret);
  } catch {
    return c.text("bad signature", 400);
  }
  const job = event.agreement_id ? jobs.get(event.agreement_id) : undefined;
  if (job) {
    await refresh(job);
    console.log(`${event.type} → ${job.agreementId} is ${job.status}`);
  }
  return c.text("ok"); // 2xx acknowledges; Proof Desk retries anything else.
});

const DEFAULT_TESTS = `import test from "node:test";
import assert from "node:assert/strict";
import { isEven } from "../even.mjs";
test("[public-tests] 4 is even", () => assert.equal(isEven(4), true));
test("[public-tests] 7 is odd", () => assert.equal(isEven(7), false));
test("[public-tests] 0 is even", () => assert.equal(isEven(0), true));
`;

// Register for events once (a real platform does this in setup, and stores the secret).
if (!webhookSecret) {
  try {
    const endpoint = await pd.webhookEndpoints.create({ url: `${SELF}/webhooks/proofdesk` });
    webhookSecret = endpoint.secret ?? "";
    console.log(`registered webhook endpoint ${endpoint.id}`);
  } catch (err) {
    console.warn(`webhooks off (${err instanceof Error ? err.message : err}); pages poll instead`);
  }
}

serve({ fetch: app.fetch, port: PORT }, () => console.log(`TaskHub on ${SELF}`));

export { app };
