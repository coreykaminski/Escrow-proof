/**
 * API key management, shared by the API (/v1/api-keys) and the dashboard's developer page.
 * A plaintext key exists only in the return value of create/roll; only its hash is stored.
 */
import { newId } from "@proofdesk/core";
import { type ApiScope, type Db, schema } from "@proofdesk/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateApiKey, hashApiKey } from "../accounts.ts";
import { ApiError } from "../errors.ts";

export type KeyRow = typeof schema.apiKeys.$inferSelect;

/** Who is acting: the calling key (API) or the signed-in key (dashboard). */
export interface KeyActor {
  accountId: string;
  apiKeyId: string;
  mode: "test" | "live";
  scopes: ApiScope[];
}

export async function listKeys(db: Db, accountId: string) {
  return db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.accountId, accountId))
    .orderBy(desc(schema.apiKeys.createdAt));
}

async function owned(db: Db, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.accountId, accountId)));
  if (!row) throw new ApiError(404, "not_found", "API key not found");
  return row;
}

async function insertKey(
  db: Db,
  p: {
    accountId: string;
    mode: "test" | "live";
    scopes: ApiScope[];
    name: string | null;
    now: Date;
  },
) {
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
      createdAt: p.now,
    })
    .returning();
  return { row: row as KeyRow, key };
}

/** Never grants more than the actor has ("verify" is a subset of "platform"). */
export async function createKey(
  db: Db,
  actor: KeyActor,
  p: { name?: string | null; scopes?: ApiScope[]; mode?: "test" | "live"; now: Date },
) {
  const scopes = [...new Set(p.scopes ?? actor.scopes)] as ApiScope[];
  const beyond = scopes.filter(
    (s) => !actor.scopes.includes(s) && !(s === "verify" && actor.scopes.includes("platform")),
  );
  if (beyond.length) {
    throw new ApiError(403, "insufficient_scope", `this key can't grant ${beyond.join(", ")}`);
  }
  const mode = p.mode ?? actor.mode;
  if (mode === "live" && actor.mode !== "live") {
    throw new ApiError(403, "livemode_mismatch", "a test key can't create live keys");
  }
  return insertKey(db, {
    accountId: actor.accountId,
    mode,
    scopes,
    name: p.name ?? null,
    now: p.now,
  });
}

/** A new key with the same settings; the old one works for `expireOldInHours` (0 = revoke now). */
export async function rollKey(
  db: Db,
  actor: KeyActor,
  p: { id: string; expireOldInHours: number; now: Date },
) {
  const old = await owned(db, actor.accountId, p.id);
  if (old.revokedAt) throw new ApiError(409, "key_revoked", "that key is already revoked");
  const created = await insertKey(db, {
    accountId: actor.accountId,
    mode: old.mode,
    scopes: old.scopes,
    name: old.name,
    now: p.now,
  });
  const expiresAt = new Date(p.now.getTime() + p.expireOldInHours * 3_600_000);
  const [updated] = await db
    .update(schema.apiKeys)
    .set(p.expireOldInHours === 0 ? { revokedAt: p.now } : { expiresAt })
    .where(eq(schema.apiKeys.id, old.id))
    .returning();
  return { created, old: updated as KeyRow };
}

export async function revokeKey(db: Db, actor: KeyActor, p: { id: string; now: Date }) {
  const row = await owned(db, actor.accountId, p.id);
  if (row.id === actor.apiKeyId) {
    throw new ApiError(
      409,
      "cannot_revoke_current_key",
      "revoke this key from another key, or roll it instead",
    );
  }
  const [updated] = await db
    .update(schema.apiKeys)
    .set({ revokedAt: row.revokedAt ?? p.now })
    .where(and(eq(schema.apiKeys.id, row.id), isNull(schema.apiKeys.revokedAt)))
    .returning();
  return updated ?? row;
}
