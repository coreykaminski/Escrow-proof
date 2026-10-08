import { randomBytes } from "node:crypto";
import { sha256Hex } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import { and, eq, gt } from "drizzle-orm";
import type { AuthContext } from "../env.ts";
import { findApiKey } from "../middleware.ts";

export const SESSION_HOURS = 12;

export interface Session extends AuthContext {
  csrfToken: string;
  accountName: string;
}

/** Exchanges an API key for a dashboard session. Returns the cookie value, or null. */
export async function startSession(db: Db, apiKey: string, now: Date): Promise<string | null> {
  const key = /^pd_(test|live)_[A-Za-z0-9_-]+$/.test(apiKey.trim())
    ? await findApiKey(db, apiKey.trim())
    : undefined;
  if (!key) return null;
  const id = randomBytes(32).toString("base64url");
  await db.insert(schema.dashboardSessions).values({
    idHash: sha256Hex(id),
    apiKeyId: key.id,
    csrfToken: randomBytes(24).toString("base64url"),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000),
    createdAt: now,
  });
  return id;
}

export async function getSession(
  db: Db,
  id: string | undefined,
  now: Date,
): Promise<Session | null> {
  if (!id) return null;
  const [row] = await db
    .select({ session: schema.dashboardSessions, key: schema.apiKeys, account: schema.accounts })
    .from(schema.dashboardSessions)
    .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.dashboardSessions.apiKeyId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.apiKeys.accountId))
    .where(
      and(
        eq(schema.dashboardSessions.idHash, sha256Hex(id)),
        gt(schema.dashboardSessions.expiresAt, now),
      ),
    )
    .limit(1);
  // A revoked key ends its sessions too.
  if (!row || row.key.revokedAt) return null;
  return {
    accountId: row.key.accountId,
    apiKeyId: row.key.id,
    mode: row.key.mode,
    scopes: row.key.scopes,
    csrfToken: row.session.csrfToken,
    accountName: row.account.name,
  };
}

export async function endSession(db: Db, id: string | undefined) {
  if (id)
    await db
      .delete(schema.dashboardSessions)
      .where(eq(schema.dashboardSessions.idHash, sha256Hex(id)));
}
