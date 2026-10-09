import { type Db, schema } from "@proofdesk/db";
import { lte, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";

/** Whether the client reached us over https (directly, or via a TLS-terminating proxy). */
export function isHttps(c: Context, publicUrl?: string): boolean {
  return (
    new URL(c.req.url).protocol === "https:" ||
    c.req.header("x-forwarded-proto") === "https" ||
    (publicUrl?.startsWith("https://") ?? false)
  );
}

/**
 * The client's IP. Proxy headers are only trusted when the deployment says it's behind one
 * (Fly sets Fly-Client-IP); otherwise anyone could pick their own rate-limit bucket.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fly = c.req.header("fly-client-ip");
    if (fly) return fly;
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

const CSP = [
  "default-src 'self'",
  // Stripe.js powers the hosted card page; everything else is first-party.
  "script-src 'self' https://js.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "connect-src 'self' https://api.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  // Pages carry one inline <style> block; no inline scripts anywhere.
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Headers on every response; CSP on HTML. `no-referrer` matters here: share and payment links
 * carry their token in the URL, which must not leak to Stripe or a cited site via Referer.
 */
export function securityHeaders(publicUrl?: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
    if (isHttps(c, publicUrl)) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (c.res.headers.get("content-type")?.includes("text/html")) {
      // A route with its own policy (the API reference) keeps it.
      if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", CSP);
      c.header("Cache-Control", "no-store");
    }
  };
}

/** Counts requests per key in fixed windows. Swap for a shared store when running >1 instance. */
export interface RateLimitStore {
  hit(
    key: string,
    windowMs: number,
    now: number,
  ): { count: number; resetAt: number } | Promise<{ count: number; resetAt: number }>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  hit(key: string, windowMs: number, now: number) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.sweep(now);
    }
    w.count++;
    return w;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}

/**
 * Counters in Postgres, so limits hold across every API instance and survive deploys. One
 * atomic upsert per request: a new window starts when the stored one has ended.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Db) {}

  async hit(key: string, windowMs: number, now: number) {
    const at = new Date(now);
    const reset = new Date(now + windowMs);
    const t = schema.rateLimits;
    const [row] = await this.db
      .insert(t)
      .values({ key, count: 1, resetAt: reset })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          count: sql`case when ${t.resetAt} <= ${at.toISOString()}::timestamptz then 1 else ${t.count} + 1 end`,
          resetAt: sql`case when ${t.resetAt} <= ${at.toISOString()}::timestamptz then ${reset.toISOString()}::timestamptz else ${t.resetAt} end`,
        },
      })
      .returning({ count: t.count, resetAt: t.resetAt });
    if (!row) throw new Error("rate limit upsert returned nothing");
    return { count: row.count, resetAt: row.resetAt.getTime() };
  }
}

/** Deletes counters whose window has ended (run from the worker). */
export async function sweepRateLimits(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(schema.rateLimits)
    .where(lte(schema.rateLimits.resetAt, now))
    .returning({ key: schema.rateLimits.key });
  return gone.length;
}

/**
 * Fixed-window rate limit. `key` returns the bucket (API key id, client IP…) or null to skip.
 * Answers 429 with Retry-After; sets RateLimit-* headers on every limited response.
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowMs: number;
  key: (c: Context) => string | null;
  store: RateLimitStore;
  now?: () => number;
}): MiddlewareHandler {
  return async (c, next) => {
    const k = opts.key(c);
    if (k === null) return next();
    const now = opts.now?.() ?? Date.now();
    let w: { count: number; resetAt: number };
    try {
      w = await opts.store.hit(`${opts.name}:${k}`, opts.windowMs, now);
    } catch (err) {
      // A limiter outage mustn't take the API down with it: fail open, loudly.
      console.error("rate limit store failed; allowing the request", err);
      return next();
    }
    const remaining = Math.max(0, opts.limit - w.count);
    const reset = Math.ceil((w.resetAt - now) / 1000);
    c.header("RateLimit-Limit", String(opts.limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(reset));
    if (w.count > opts.limit) {
      c.header("Retry-After", String(reset));
      throw new ApiError(429, "rate_limited", `too many requests; retry in ${reset}s`);
    }
    await next();
  };
}
