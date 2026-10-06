import { sha256Hex } from "@proofdesk/core";
import { type ApiScope, schema } from "@proofdesk/db";
import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hashApiKey } from "./accounts.ts";
import type { AppDeps, AppEnv } from "./env.ts";
import { ApiError } from "./errors.ts";

export function authenticate({ db, now }: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+(pd_(?:test|live)_[A-Za-z0-9_-]+)$/.exec(header);
    if (!match?.[1]) {
      throw new ApiError(401, "unauthenticated", "missing or malformed API key");
    }

    const [row] = await db
      .select({
        id: schema.apiKeys.id,
        accountId: schema.apiKeys.accountId,
        mode: schema.apiKeys.mode,
        scopes: schema.apiKeys.scopes,
      })
      .from(schema.apiKeys)
      .where(
        and(eq(schema.apiKeys.keyHash, hashApiKey(match[1])), isNull(schema.apiKeys.revokedAt)),
      )
      .limit(1);
    if (!row) throw new ApiError(401, "unauthenticated", "invalid or revoked API key");

    await db.update(schema.apiKeys).set({ lastUsedAt: now() }).where(eq(schema.apiKeys.id, row.id));

    c.set("auth", {
      accountId: row.accountId,
      apiKeyId: row.id,
      mode: row.mode,
      scopes: row.scopes,
    });
    await next();
  };
}

export function requireScope(scope: ApiScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("auth").scopes.includes(scope)) {
      throw new ApiError(403, "insufficient_scope", `this API key lacks the "${scope}" scope`);
    }
    await next();
  };
}

/**
 * Stripe-style idempotency: a retried POST/PUT with the same Idempotency-Key gets the original
 * response instead of running twice. Reusing a key with a different request is an error.
 * 5xx responses aren't stored, so the client can safely retry them.
 */
export function idempotency({ db }: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("Idempotency-Key");
    if (!key || (c.req.method !== "POST" && c.req.method !== "PUT")) return next();
    if (key.length > 255) {
      throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be ≤255 chars");
    }

    const { accountId } = c.get("auth");
    const requestHash = sha256Hex(`${c.req.method} ${c.req.path}\n${await c.req.text()}`);

    const claimed = await db
      .insert(schema.idempotencyKeys)
      .values({ accountId, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });

    const where = and(
      eq(schema.idempotencyKeys.accountId, accountId),
      eq(schema.idempotencyKeys.key, key),
    );

    if (claimed.length === 0) {
      const [existing] = await db.select().from(schema.idempotencyKeys).where(where).limit(1);
      if (!existing || existing.requestHash !== requestHash) {
        throw new ApiError(
          422,
          "idempotency_key_reused",
          "this Idempotency-Key was already used with a different request",
        );
      }
      if (existing.statusCode === null) {
        throw new ApiError(
          409,
          "idempotency_request_in_progress",
          "a request with this Idempotency-Key is still being processed",
        );
      }
      c.header("Idempotent-Replayed", "true");
      return c.json(existing.responseBody, existing.statusCode as ContentfulStatusCode);
    }

    await next();

    if (c.res.status >= 500) {
      await db.delete(schema.idempotencyKeys).where(where);
      return;
    }
    await db
      .update(schema.idempotencyKeys)
      .set({ statusCode: c.res.status, responseBody: await c.res.clone().json() })
      .where(where);
  };
}
