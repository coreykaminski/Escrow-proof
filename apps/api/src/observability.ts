/**
 * What operators see: one structured log line per request (by route pattern, so share and
 * payment tokens never reach the logs), a request id on every response and error, in-process
 * request metrics for /v1/ops/metrics, and an optional alert webhook for things that need a
 * human now (server errors, worker failures, a broken ledger).
 */
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  opts: {
    level?: Level | "silent";
    format?: "json" | "text";
    sink?: (line: string, level: Level) => void;
  } = {},
): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const sink =
    opts.sink ??
    ((line: string, level: Level) =>
      level === "error" || level === "warn" ? console.error(line) : console.log(line));
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[level] < min) return;
    const at = new Date().toISOString();
    if (opts.format === "text") {
      const extra = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      sink(`${at} ${level.toUpperCase()} ${msg}${extra ? ` ${extra}` : ""}`, level);
    } else {
      sink(JSON.stringify({ at, level, msg, ...fields }), level);
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger = createLogger({ level: "silent" });

/** LOG_LEVEL (default info), LOG_FORMAT json|text (default: json in production, text otherwise). */
export function loggerFromEnv(env = process.env): Logger {
  const level = (env.LOG_LEVEL as Level | "silent" | undefined) ?? "info";
  const format =
    (env.LOG_FORMAT as "json" | "text" | undefined) ??
    (env.NODE_ENV === "production" ? "json" : "text");
  return createLogger({ level: level in LEVELS ? level : "info", format });
}

/** Rolling request statistics since process start (one instance; aggregate across machines). */
export class RequestMetrics {
  private readonly started = new Date();
  private total = 0;
  private readonly byClass: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private readonly routes = new Map<string, { count: number; errors: number; ms: number }>();
  /** The last N latencies (a ring), for percentiles. */
  private readonly window: number[] = [];
  private next = 0;
  constructor(private readonly size = 2_000) {}

  record(route: string, status: number, ms: number) {
    this.total++;
    const cls = `${Math.floor(status / 100)}xx`;
    this.byClass[cls] = (this.byClass[cls] ?? 0) + 1;
    const r = this.routes.get(route) ?? { count: 0, errors: 0, ms: 0 };
    r.count++;
    r.ms += ms;
    if (status >= 500) r.errors++;
    this.routes.set(route, r);
    if (this.window.length < this.size) this.window.push(ms);
    else this.window[this.next] = ms;
    this.next = (this.next + 1) % this.size;
  }

  snapshot() {
    const sorted = [...this.window].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) : 0;
    return {
      since: this.started.toISOString(),
      requests: this.total,
      by_status: { ...this.byClass },
      latency_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), sample: sorted.length },
      routes: [...this.routes]
        .map(([route, r]) => ({
          route,
          count: r.count,
          errors_5xx: r.errors,
          mean_ms: Math.round(r.ms / r.count),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25),
    };
  }
}

/**
 * Posts alerts to ALERT_WEBHOOK_URL (Slack/Discord-compatible `text`), at most once per event
 * kind per `quietMs`, so an outage pages once rather than once per request. Never throws.
 */
export class Alerter {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly url: string,
    private readonly opts: { fetch?: typeof fetch; quietMs?: number; logger?: Logger } = {},
  ) {}

  async notify(kind: string, text: string, details: Record<string, unknown> = {}) {
    const now = Date.now();
    const prev = this.last.get(kind);
    if (prev !== undefined && now - prev < (this.opts.quietMs ?? 10 * 60_000)) return;
    this.last.set(kind, now);
    try {
      const res = await (this.opts.fetch ?? fetch)(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Proof Desk: ${text}`, kind, ...details }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) this.opts.logger?.warn("alert webhook refused", { status: res.status, kind });
    } catch (err) {
      this.opts.logger?.warn("alert webhook failed", { kind, error: String(err) });
    }
  }
}

export function alerterFromEnv(logger: Logger, env = process.env): Alerter | undefined {
  return env.ALERT_WEBHOOK_URL ? new Alerter(env.ALERT_WEBHOOK_URL, { logger }) : undefined;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Assigns a request id (keeping a well-formed incoming X-Request-Id, e.g. from Fly's proxy),
 * returns it in X-Request-Id, and logs one line per request by route pattern.
 */
export function requestObservability(deps: {
  logger: Logger;
  metrics: RequestMetrics;
}): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    c.set("requestId" as never, id as never);
    c.header("X-Request-Id", id);
    const started = performance.now();
    try {
      await next();
    } finally {
      const ms = Math.round(performance.now() - started);
      const route = routeOf(c);
      const status = c.res.status;
      deps.metrics.record(`${c.req.method} ${route}`, status, ms);
      const auth = c.get("auth" as never) as { accountId?: string; apiKeyId?: string } | undefined;
      deps.logger[status >= 500 ? "error" : "info"]("request", {
        request_id: id,
        method: c.req.method,
        route,
        status,
        ms,
        ...(auth?.accountId ? { account: auth.accountId, key: auth.apiKeyId } : {}),
      });
    }
  };
}

/** The matched route pattern ("/r/:token"), never the concrete path, which may hold secrets. */
export function routeOf(c: Context): string {
  const handlers = c.req.matchedRoutes.filter((r) => r.method !== "ALL");
  return handlers.at(-1)?.path ?? "(unmatched)";
}
