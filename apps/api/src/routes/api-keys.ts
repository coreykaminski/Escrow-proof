/**
 * Platforms manage their own API keys: list, create (named, scoped, never more powerful than
 * the caller), roll with a grace period for zero-downtime rotation, and revoke. A plaintext key
 * is returned once, at creation; only its hash is stored.
 */
import type { ApiScope } from "@proofdesk/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../env.ts";
import { createKey, type KeyRow, listKeys, revokeKey, rollKey } from "../services/api-keys.ts";

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

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const rows = await listKeys(db, auth.accountId);
    return c.json({ object: "list", data: rows.map((k) => apiKeyJson(k, auth.apiKeyId, now())) });
  });

  r.post("/", async (c) => {
    const body = CreateKeyBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const { row, key } = await createKey(db, auth, {
      name: body.name ?? null,
      ...(body.scopes ? { scopes: body.scopes as ApiScope[] } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      now: now(),
    });
    return c.json({ ...apiKeyJson(row, auth.apiKeyId, now()), key }, 201);
  });

  /** A new key with the same settings; the old one keeps working for the grace period. */
  r.post("/:id/roll", async (c) => {
    const body = RollKeyBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const at = now();
    const { created, old } = await rollKey(db, auth, {
      id: c.req.param("id"),
      expireOldInHours: body.expire_old_in_hours,
      now: at,
    });
    return c.json(
      {
        key: { ...apiKeyJson(created.row, auth.apiKeyId, at), key: created.key },
        old_key: apiKeyJson(old, auth.apiKeyId, at),
      },
      201,
    );
  });

  r.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const row = await revokeKey(db, auth, { id: c.req.param("id"), now: now() });
    return c.json(apiKeyJson(row, auth.apiKeyId, now()));
  });

  return r;
}
