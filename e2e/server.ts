/**
 * The browser tests' server: the real app on an in-memory database, seeded with a platform and
 * an ops account, an escalated case waiting for review, and a final verdict with a report link.
 * Writes the keys and URLs the tests need to e2e/.state.json (git-ignored).
 *
 *   npx tsx e2e/server.ts   (Playwright starts it; see playwright.config.ts)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createDb } from "@proofdesk/db";
import { createAccountWithKey } from "../apps/api/src/accounts.ts";
import { createApp } from "../apps/api/src/app.ts";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const handle = createDb("memory://");
await handle.migrate();
const platform = await createAccountWithKey(handle.db, { name: "E2E Platform" });
const ops = await createAccountWithKey(handle.db, { name: "E2E Reviewer", scopes: ["ops"] });
const app = createApp({ db: handle.db, now: () => new Date(), allowPrivateNetwork: true });

// biome-ignore lint/suspicious/noExplicitAny: seed responses are read field by field
async function call(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

/** Created, approved, funded on the test rail and delivered. */
async function delivered(title: string) {
  const agr = await call(platform.apiKey, "POST", "/v1/agreements/from-template", {
    buyer_ref: "e2e_buyer",
    seller_ref: "e2e_seller",
    template: "research.cited-brief",
    params: { task: title, title, min_sources: 1 },
    amount: { value: 25_000, currency: "usd" },
    delivery_due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    appeal_window_hours: 0,
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: agr.spec_hash,
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/fund`, {
    rail: "test",
    hold_ref: "e2e",
  });
  await call(platform.apiKey, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [
      { name: "brief.md", media_type: "text/markdown", content: "Findings, with sources." },
    ],
  });
  await call(ops.apiKey, "POST", `/v1/ops/agreements/${agr.id}/start-verification`);
  return agr.id as string;
}

// Waiting for a reviewer: the verifier escalated it.
const escalated = await delivered("Brief on heat pumps");
const { applyEvent } = await import("../apps/api/src/services/agreements.ts");
await applyEvent(handle.db, {
  agreementId: escalated,
  scope: {},
  event: { type: "ESCALATE", reason: "The checks disagree on quotes-verbatim." },
  actor: { role: "system", ref: "verifier" },
  now: new Date(),
});

// Final: decided by a human and settled, with a shareable report.
const final = await delivered("Brief on grid storage");
await call(ops.apiKey, "POST", `/v1/ops/agreements/${final}/decide`, {
  outcome: { kind: "release" },
  reason: "Every source loads and quotes match.",
});
await call(ops.apiKey, "POST", `/v1/ops/agreements/${final}/settle`, { settlement_ref: "e2e" });
const link = await call(platform.apiKey, "POST", `/v1/agreements/${final}/report-links`, {});

// A stand-in for a customer's marketplace on another origin, embedding the verdict widget.
const HOST_PORT = PORT - 1;
const token = new URL(link.url).pathname.split("/").pop();
serve({
  port: HOST_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Marketplace</title></head><body>
<h1>Order #1042</h1>
<script src="http://localhost:${PORT}/embed/v1.js" async></script>
<div data-proofdesk-verdict="${token}" data-theme="light"></div>
<p id="after">More marketplace content</p>
</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    ),
});

serve({ fetch: app.fetch, port: PORT }, () => {
  writeFileSync(
    join(import.meta.dirname, ".state.json"),
    JSON.stringify({
      base: `http://localhost:${PORT}`,
      opsKey: ops.apiKey,
      platformKey: platform.apiKey,
      escalated,
      final,
      reportPath: new URL(link.url).pathname,
      hostPage: `http://localhost:${HOST_PORT}/`,
    }),
  );
  console.log(`e2e server on http://localhost:${PORT}`);
});
