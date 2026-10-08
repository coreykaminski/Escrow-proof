import { randomBytes } from "node:crypto";
import { sha256Hex } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import { and, eq, gt, isNull } from "drizzle-orm";

export type LinkKind = "report" | "pay";

/** Creates an unguessable link token; only its hash is stored. */
export async function createShareLink(
  db: Db,
  p: { kind: LinkKind; agreementId: string; createdByKeyId: string; ttlDays: number; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(p.now.getTime() + p.ttlDays * 86_400_000);
  await db.insert(schema.shareLinks).values({
    tokenHash: sha256Hex(token),
    kind: p.kind,
    agreementId: p.agreementId,
    createdByKeyId: p.createdByKeyId,
    expiresAt,
    createdAt: p.now,
  });
  return { token, expiresAt };
}

/** The agreement a live, unrevoked link of this kind points to, or null. */
export async function resolveShareLink(
  db: Db,
  token: string,
  kind: LinkKind,
  now: Date,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db
    .select({ agreementId: schema.shareLinks.agreementId })
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.tokenHash, sha256Hex(token)),
        eq(schema.shareLinks.kind, kind),
        isNull(schema.shareLinks.revokedAt),
        gt(schema.shareLinks.expiresAt, now),
      ),
    )
    .limit(1);
  return row?.agreementId ?? null;
}

export async function revokeShareLinks(db: Db, agreementId: string, kind: LinkKind, now: Date) {
  await db
    .update(schema.shareLinks)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.shareLinks.agreementId, agreementId),
        eq(schema.shareLinks.kind, kind),
        isNull(schema.shareLinks.revokedAt),
      ),
    );
}
