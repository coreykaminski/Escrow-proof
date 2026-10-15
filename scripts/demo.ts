/**
 * One-command demo: `npm run demo`. Everything runs locally, nothing to sign up for:
 *   - the Proof Desk API and dashboard (real code and data checks, in-memory database),
 *   - the scheduler (settlements, webhooks) every few seconds,
 *   - TaskHub, the sample marketplace, wired to Proof Desk,
 *   - a mock "customer site" embedding the verdict widget,
 * seeded with a realistic picture, and a printed guide of what to show.
 *
 *   npm run demo            # then open the URLs it prints; Ctrl+C to stop
 */
import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { FakeAnchorGateway } from "@proofdesk/chain";
import { createDb, schema } from "@proofdesk/db";
import {
  guardedTransport,
  NodePermissionSandbox,
  verifyCode,
  verifyData,
} from "@proofdesk/verifier";
import { eq } from "drizzle-orm";
import { createAccountWithKey } from "../apps/api/src/accounts.ts";
import { createApp } from "../apps/api/src/app.ts";
import { tick } from "../apps/api/src/services/scheduler.ts";

const API_PORT = Number(process.env.DEMO_API_PORT ?? 8787);
const TASKHUB_PORT = Number(process.env.DEMO_TASKHUB_PORT ?? 3000);
const SITE_PORT = Number(process.env.DEMO_SITE_PORT ?? 3001);
const API = `http://localhost:${API_PORT}`;

const handle = createDb("memory://");
await handle.migrate();
const db = handle.db;
const anchor = new FakeAnchorGateway(); // stands in for the on-chain LedgerAnchor contract

// The research checker fetches cited sources; in the demo they come from a small offline web.
const WEB: Record<string, string> = {
  "https://energy.example/storage-2026":
    "Report on grid storage. ".repeat(30) +
    "Utility-scale battery prices fell by 18 percent between 2024 and 2026.",
  "https://grid.example/outlook":
    "Grid outlook. ".repeat(30) + "Storage capacity is expected to double by 2028.",
};
const app = createApp({
  db,
  now: () => new Date(),
  anchor,
  allowPrivateNetwork: true,
  publicUrl: API,
  rateLimits: { apiPerMinute: 100_000, publicPerMinute: 100_000 },
  codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
  dataVerifier: (input) =>
    verifyData(input, {
      transport: guardedTransport(async (url) =>
        WEB[url]
          ? { status: "ok", url, content_type: "text/plain", body: WEB[url] as string }
          : { status: "unreachable", url, http_status: 404 },
      ),
    }),
});

const platform = await createAccountWithKey(db, { name: "Acme Marketplace (sandbox)" });
const live = await createAccountWithKey(db, { name: "Acme Marketplace (live)", mode: "live" });
const ops = await createAccountWithKey(db, { name: "Proof Desk reviewer", scopes: ["ops"] });

// biome-ignore lint/suspicious/noExplicitAny: demo responses are read field by field
async function call(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path}: ${JSON.stringify(json.error)}`);
  return json;
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const TESTS = `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../slugify.mjs";
test("[public-tests] lowercases and joins words", () => assert.equal(slugify("Hello World"), "hello-world"));
test("[public-tests] drops punctuation", () => assert.equal(slugify("Ready, set... go!"), "ready-set-go"));
test("[hidden-tests] collapses repeated separators", () => assert.equal(slugify("a  --  b"), "a-b"));
`;
const GOOD_CODE = `export const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");`;
const LAZY_CODE = `export const slugify = (s) => s.toLowerCase().split(" ").join("-").replace(/[^a-z-]/g, "");`;

/** A code job through to a verdict (sandbox key: test rail). */
async function codeJob(title: string, code: string, opts: { appealHours?: number } = {}) {
  let a = await call(platform.apiKey, "POST", "/v1/agreements/from-template", {
    buyer_ref: "buyer_dana",
    seller_ref: "agent_slugsmith",
    template: "code.acceptance-tests",
    params: { task: title, title, hidden_tests: true },
    amount: { value: 4_000, currency: "usd" },
    delivery_due_at: inDays(3),
    appeal_window_hours: opts.appealHours ?? 0,
  });
  a = await call(platform.apiKey, "PUT", `/v1/agreements/${a.id}/inputs`, {
    inputs: [{ name: "tests/slugify.test.mjs", media_type: "text/javascript", content: TESTS }],
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${a.id}/approve-spec`, {
    spec_hash: a.spec_hash,
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${a.id}/fund`, {
    rail: "test",
    hold_ref: "demo",
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${a.id}/deliveries`, {
    artifacts: [{ name: "slugify.mjs", media_type: "text/javascript", content: code }],
  });
  await call(ops.apiKey, "POST", `/v1/ops/agreements/${a.id}/verify`);
  return a.id as string;
}

console.log("Seeding the demo…");
// 1. Passed and paid: a shareable report and an embeddable widget.
const passed = await codeJob("slugify(s) for blog URLs", GOOD_CODE);
// 2. Failed: passes the public tests but not the buyer's hidden one → refund.
const failed = await codeJob("slugify(s) for product URLs", LAZY_CODE);
// 3. Waiting for a human: the reviewer queue.
let escalated = await call(platform.apiKey, "POST", "/v1/agreements/from-template", {
  buyer_ref: "buyer_lee",
  seller_ref: "agent_researcher",
  template: "research.cited-brief",
  params: { task: "One-page brief on grid storage costs, citing sources.", min_sources: 2 },
  amount: { value: 12_000, currency: "usd" },
  delivery_due_at: inDays(5),
});
await call(platform.apiKey, "POST", `/v1/agreements/${escalated.id}/approve-spec`, {
  spec_hash: escalated.spec_hash,
});
await call(platform.apiKey, "POST", `/v1/agreements/${escalated.id}/fund`, {
  rail: "test",
  hold_ref: "demo",
});
await call(platform.apiKey, "POST", `/v1/agreements/${escalated.id}/deliveries`, {
  artifacts: [
    {
      name: "brief.md",
      media_type: "text/markdown",
      // Two sources in one paragraph: the quote can't be attributed automatically, so a human decides.
      content:
        'Battery prices "fell by 18 percent between 2024 and 2026" (https://energy.example/storage-2026, https://grid.example/outlook).',
    },
  ],
});
escalated = (await call(ops.apiKey, "POST", `/v1/ops/agreements/${escalated.id}/verify`)).agreement;
await call(ops.apiKey, "POST", "/v1/ops/run-due"); // settle what's final
const report = await call(platform.apiKey, "POST", `/v1/agreements/${passed}/report-links`, {});
const failedReport = await call(
  platform.apiKey,
  "POST",
  `/v1/agreements/${failed}/report-links`,
  {},
);

// 4. Live account in pilot "shadow mode": a correct automatic decision awaiting human review.
const liveAccount = await db
  .select()
  .from(schema.accounts)
  .where(eq(schema.accounts.name, "Acme Marketplace (live)"));
await call(ops.apiKey, "PUT", `/v1/ops/accounts/${liveAccount[0]?.id}/shadow-mode`, {
  enabled: true,
});
const csv = (rows: number) =>
  `sku,name,price_cents\n${Array.from({ length: rows }, (_, i) => `SKU-${1000 + i},Item ${i},${199 + i}`).join("\n")}\n`;
const schemaJson = JSON.stringify({
  type: "array",
  "x-unique-keys": ["sku"],
  items: {
    type: "object",
    required: ["sku", "name", "price_cents"],
    properties: { sku: { type: "string" }, price_cents: { type: "integer", minimum: 1 } },
  },
});
const shadowJob = await call(live.apiKey, "POST", "/v1/verifications", {
  template: {
    id: "data.dataset",
    params: { task: "Catalogue of 25 products.", min_records: 25, unique_key: "sku" },
  },
  inputs: [{ name: "schema.json", media_type: "application/schema+json", content: schemaJson }],
  deliverable: [{ name: "catalogue.csv", media_type: "text/csv", content: csv(25) }],
});
// 5. Live Verify API checks that are final: sealed as anonymous public verdicts and anchored.
await call(ops.apiKey, "PUT", `/v1/ops/accounts/${liveAccount[0]?.id}/shadow-mode`, {
  enabled: false,
});
for (const rows of [30, 12, 40]) {
  await call(live.apiKey, "POST", "/v1/verifications", {
    template: {
      id: "data.dataset",
      params: { task: "Product catalogue.", min_records: 25, unique_key: "sku" },
    },
    inputs: [{ name: "schema.json", media_type: "application/schema+json", content: schemaJson }],
    deliverable: [{ name: "catalogue.csv", media_type: "text/csv", content: csv(rows) }],
  });
}
await call(ops.apiKey, "POST", "/v1/ops/run-due");
await call(ops.apiKey, "POST", "/v1/ops/ledger/anchor");

// Servers.
const api = serve({ fetch: app.fetch, port: API_PORT });
const site = serve({
  port: SITE_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Acme Marketplace: order #2207</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}</style></head><body>
<p style="color:#888">Acme Marketplace (a customer's own site)</p>
<h1>Order #2207: slugify(s) for blog URLs</h1>
<p>Seller: agent_slugsmith · $40.00 · paid only if it passes</p>
${report.embed.html}
<h2 style="margin-top:32px">Another order</h2>
${failedReport.embed.html}
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ),
});
const taskhub = spawn("npx", ["tsx", "examples/marketplace/server.ts"], {
  env: {
    ...process.env,
    PORT: String(TASKHUB_PORT),
    PROOFDESK_API_KEY: platform.apiKey,
    PROOFDESK_BASE_URL: API,
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const scheduler = setInterval(() => {
  tick(db, { allowPrivateNetwork: true }, new Date()).catch(() => {});
}, 5_000);

console.log(`
Proof Desk demo is running.

  WHAT TO SHOW                                                 WHERE
  1. A customer's site with the verdict widget                 http://localhost:${SITE_PORT}
  2. A full verdict report + downloadable proof (passed)        ${report.url}
     …and one that failed the buyer's hidden test               ${failedReport.url}
  3. The sample marketplace: post, approve, pay, deliver        http://localhost:${TASKHUB_PORT}
  4. Reviewer dashboard: review queue + pilot shadow review     ${API}/dashboard  (key below: "reviewer")
  5. Platform dashboard: agreements, usage and billing          ${API}/dashboard  (key below: "platform")
  6. Public trust pages                                         ${API}/accuracy   ${API}/verdicts.json
  7. API reference and agent card                               ${API}/docs       ${API}/.well-known/agent-card.json
  8. Developer sign-up                                          ${API}/signup

  Keys (sandbox, this demo only):
    platform  ${platform.apiKey}
    reviewer  ${ops.apiKey}

  In the queue: ${escalated.id} (a research brief a human must decide)
  Shadow review: ${shadowJob.id} (an automatic pass waiting for a reviewer to confirm)

Ctrl+C to stop.`);

const stop = async () => {
  clearInterval(scheduler);
  taskhub.kill();
  api.close();
  site.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
