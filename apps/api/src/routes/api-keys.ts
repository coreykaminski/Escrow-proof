/**
 * Platforms manage their own API keys: list, create (named, scoped, never more powerful than
 * the caller), roll with a grace period for zero-downtime rotation, and revoke. A plaintext key
 * is returned once, at creation; only its hash is stored.
 */
import { newId } from "@proofdesk/core";
import { type ApiScope, schema } from "@proofdesk/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../accounts.ts";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";

type KeyRow = typeof schema.apiKeys.$inferSelect;

export const CreateKeyBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  /** Defaults to the calling key's scopes. "verify": Verify API, A2A and templates only. */
  scopes: z
    .array(z.enum(["platform", "ops", "verify"]))
    .min(1)
    .max(3)
    .optional(),
  /** A live key may create test keys; a test key can't create live ones. */
  mode: z.enum(["test", "live"]).optional(),
});
export const RollKeyBody = z.object({
  /** How long the old key keeps working (0 = stop now; up to 7 days). */
  expire_old_in_hours: z.number().int().min(0).max(168).default(24),
});

export function apiKeyJson(row: KeyRow, currentKeyId: string, now: Date) {
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  return {
    id: row.id,
    object: "api_key",
    name: row.name,
    prefix: row.prefix,
    mode: row.mode,
    scopes: row.scopes,
    status: row.revokedAt ? "revoked" : expired ? "expired" : "active",
    current: row.id === currentKeyId,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

export function apiKeyRoutes({ db, now }: AppDeps) {
  const r = new Hono<AppEnv>();

  const owned = async (c: { get(k: "auth"): { accountId: string } }, id: string) => {
    const [row] = await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.accountId, c.get("auth").accountId)));
    if (!row) throw new ApiError(404, "not_found", "API key not found");
    return row;
  };

  const insertKey = async (p: {
    accountId: string;
    mode: "test" | "live";
    scopes: ApiScope[];
    name: string | null;
  }) => {
    const key = generateApiKey(p.mode);
    const [row] = await db
      .insert(schema.apiKeys)
      .values({
        id: newId("apiKey"),
        accountId: p.accountId,
        prefix: key.slice(0, 12),
        keyHash: hashApiKey(key),
        mode: p.mode,
        scopes: p.scopes,
        name: p.name,
        createdAt: now(),
      })
      .returning();
    return { row: row as KeyRow, key };
  };

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const rows = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.accountId, auth.accountId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return c.json({ object: "list", data: rows.map((k) => apiKeyJson(k, auth.apiKeyId, now())) });
  });

  r.post("/", async (c) => {
    const body = CreateKeyBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const scopes = [...new Set(body.scopes ?? auth.scopes)] as ApiScope[];
    const beyond = scopes.filter(
      (s) => !auth.scopes.includes(s) && !(s === "verify" && auth.scopes.includes("platform")),
    );
    if (beyond.length) {
      throw new ApiError(403, "insufficient_scope", `this key can't grant ${beyond.join(", ")}`);
    }
    const mode = body.mode ?? auth.mode;
    if (mode === "live" && auth.mode !== "live") {
      throw new ApiError(403, "livemode_mismatch", "a test key can't create live keys");
    }
    const { row, key } = await insertKey({
      accountId: auth.accountId,
      mode,
      scopes,
      name: body.name ?? null,
    });
    return c.json({ ...apiKeyJson(row, auth.apiKeyId, now()), key }, 201);
  });

  /** A new key with the same settings; the old one keeps working for the grace period. */
  r.post("/:id/roll", async (c) => {
    const body = RollKeyBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const old = await owned(c, c.req.param("id"));
    if (old.revokedAt) throw new ApiError(409, "key_revoked", "that key is already revoked");
    const at = now();
    const { row, key } = await insertKey({
      accountId: auth.accountId,
      mode: old.mode,
      scopes: old.scopes,
      name: old.name,
    });
    const expiresAt = new Date(at.getTime() + body.expire_old_in_hours * 3_600_000);
    const [updated] = await db
      .update(schema.apiKeys)
      .set(body.expire_old_in_hours === 0 ? { revokedAt: at } : { expiresAt })
      .where(eq(schema.apiKeys.id, old.id))
      .returning();
    return c.json(
      {
        key: { ...apiKeyJson(row, auth.apiKeyId, at), key },
        old_key: apiKeyJson(updated as KeyRow, auth.apiKeyId, at),
      },
      201,
    );
  });

  r.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const row = await owned(c, c.req.param("id"));
    if (row.id === auth.apiKeyId) {
      throw new ApiError(
        409,
        "cannot_revoke_current_key",
        "revoke this key from another key, or roll it instead",
      );
    }
    const [updated] = await db
      .update(schema.apiKeys)
      .set({ revokedAt: row.revokedAt ?? now() })
      .where(and(eq(schema.apiKeys.id, row.id), isNull(schema.apiKeys.revokedAt)))
      .returning();
    return c.json(apiKeyJson(updated ?? row, auth.apiKeyId, now()));
  });

  return r;
}
