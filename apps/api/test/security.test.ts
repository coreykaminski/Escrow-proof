/** Part 9 hardening: headers, rate and size limits, SSRF rules for webhooks, cookies. */
import { schema } from "@proofdesk/db";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { PostgresRateLimitStore, type RateLimitStore, sweepRateLimits } from "../src/security.ts";
import { deliverWebhooks } from "../src/services/webhooks.ts";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("security headers", () => {
  it("sets no-referrer, nosniff and frame denial everywhere, and a strict CSP on HTML", async () => {
    h = await createHarness();
    const api = await h.call(h.keys.platformA, "GET", "/v1/agreements");
    expect(api.headers.get("referrer-policy")).toBe("no-referrer");
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("strict-transport-security")).toBeNull();

    const page = await h.fetch("http://x/dashboard/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(page.headers.get("strict-transport-security")).toContain("max-age=");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("gives the API reference its own policy and a pinned, integrity-checked bundle", async () => {
    h = await createHarness();
    const res = await h.fetch("http://x/docs");
    expect(res.headers.get("content-security-policy")).toContain("https://cdn.jsdelivr.net");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//);
    expect(html).toContain('integrity="sha384-');
  });
});

describe("rate limits", () => {
  it("limits each API key separately and says when to retry", async () => {
    h = await createHarness({ rateLimits: { apiPerMinute: 3 } });
    for (let i = 0; i < 3; i++) {
      expect((await h.call(h.keys.platformA, "GET", "/v1/agreements")).status).toBe(200);
    }
    const limited = await h.call(h.keys.platformA, "GET", "/v1/agreements");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.call(h.keys.platformB, "GET", "/v1/agreements")).status).toBe(200);
  });

  it("limits dashboard sign-in attempts per IP (trusting the proxy's client IP)", async () => {
    h = await createHarness({ rateLimits: { loginPer15Minutes: 2 }, trustProxy: true });
    const attempt = (ip: string) =>
      h.fetch("http://x/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "fly-client-ip": ip },
        body: "api_key=pd_test_wrong",
      });
    expect((await attempt("203.0.113.5")).status).toBe(401);
    expect((await attempt("203.0.113.5")).status).toBe(401);
    expect((await attempt("203.0.113.5")).status).toBe(429);
    expect((await attempt("203.0.113.9")).status).toBe(401);
    // Viewing the form isn't limited.
    expect((await h.fetch("http://x/dashboard/login")).status).toBe(200);
  });

  it("shares one limit across API instances when counters live in Postgres", async () => {
    h = await createHarness();
    const instance = (store: RateLimitStore) =>
      createApp({
        db: h.handle.db,
        now: () => h.clock.now,
        rateLimits: { apiPerMinute: 4 },
        rateLimitStore: store,
      });
    const a = instance(new PostgresRateLimitStore(h.handle.db));
    const b = instance(new PostgresRateLimitStore(h.handle.db));
    const get = (app: ReturnType<typeof createApp>) =>
      app.request("/v1/agreements", { headers: { Authorization: `Bearer ${h.keys.platformA}` } });
    const statuses = [];
    for (const app of [a, b, a, b, a, b]) statuses.push((await get(app)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    expect((await get(a)).headers.get("ratelimit-remaining")).toBe("0");
  });

  it("starts a new window when the old one ends, and sweeps finished windows", async () => {
    h = await createHarness();
    const store = new PostgresRateLimitStore(h.handle.db);
    const t0 = Date.parse("2026-10-09T12:00:00Z");
    expect((await store.hit("k", 60_000, t0)).count).toBe(1);
    expect((await store.hit("k", 60_000, t0 + 1_000)).count).toBe(2);
    const next = await store.hit("k", 60_000, t0 + 61_000);
    expect(next).toEqual({ count: 1, resetAt: t0 + 121_000 });
    await store.hit("other", 1_000, t0);
    expect(await sweepRateLimits(h.handle.db, new Date(t0 + 5_000))).toBe(1);
    expect((await store.hit("k", 60_000, t0 + 62_000)).count).toBe(2);
  });

  it("fails open if the limiter's store is down", async () => {
    h = await createHarness();
    const app = createApp({
      db: h.handle.db,
      now: () => h.clock.now,
      rateLimitStore: {
        hit: async () => {
          throw new Error("db down");
        },
      },
    });
    const res = await app.request("/v1/agreements", {
      headers: { Authorization: `Bearer ${h.keys.platformA}` },
    });
    expect(res.status).toBe(200);
  });

  it("limits share and payment links per IP", async () => {
    h = await createHarness({ rateLimits: { publicPerMinute: 2 } });
    expect((await h.fetch("http://x/r/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await h.fetch("http://x/r/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await h.fetch("http://x/r/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(429);
  });
});

describe("request size", () => {
  it("rejects oversized bodies before parsing them", async () => {
    h = await createHarness();
    const big = JSON.stringify({
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture({ request: "x".repeat(25 * 1024 * 1024) }),
    });
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements", big, {
      "Content-Length": String(big.length),
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });
});

describe("outbound webhooks (production rules)", () => {
  it("only accepts public https endpoints", async () => {
    h = await createHarness({ allowPrivateNetwork: false });
    const create = (url: string) =>
      h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", { url });
    expect((await create("http://localhost:3000/x")).body.error.code).toBe("insecure_url");
    expect((await create("https://localhost/x")).body.error.code).toBe("url_not_allowed");
    expect((await create("https://10.0.0.8/hooks")).body.error.code).toBe("url_not_allowed");
    expect((await create("https://169.254.169.254/latest")).body.error.code).toBe(
      "url_not_allowed",
    );
    expect((await create("https://hooks.internal/x")).body.error.code).toBe("url_not_allowed");
    expect((await create("https://platform.example:6379/x")).body.error.code).toBe(
      "url_not_allowed",
    );
    expect((await create("https://platform.example/hooks")).status).toBe(201);
  });

  it("refuses to deliver to a private address even if one got stored", async () => {
    h = await createHarness();
    const now = new Date();
    const [acct] = await h.handle.db.select().from(schema.accounts).limit(1);
    await h.handle.db.insert(schema.webhookEndpoints).values({
      id: "we_test_private",
      accountId: acct?.id as string,
      url: "https://127.0.0.1/hooks",
      secret: "whsec_pd_x",
      eventTypes: [],
      cursorSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    const agr = (
      await h.call(h.keys.platformA, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture(),
      })
    ).body;
    expect(agr.id).toBeTruthy();
    const result = await deliverWebhooks(h.handle.db, { now, allowPrivate: false });
    expect(result.failed).toContain("we_test_private");
    const [ep] = await h.handle.db.select().from(schema.webhookEndpoints);
    expect(ep?.lastError).toMatch(/private or reserved/);
  });
});

describe("dashboard cookie", () => {
  it("is Secure behind a TLS-terminating proxy", async () => {
    h = await createHarness();
    const res = await h.fetch("http://x/dashboard/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https",
      },
      body: `api_key=${encodeURIComponent(h.keys.platformA)}`,
      redirect: "manual",
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });
});
