import { createHmac, randomBytes } from "node:crypto";
import { newId } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { ApiError } from "../errors.ts";

export type EndpointRow = typeof schema.webhookEndpoints.$inferSelect;

const BATCH = 50;
const MAX_FAILURES = 20;
const TIMEOUT_MS = 10_000;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the same scheme Stripe uses. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** Retry delay after the nth consecutive failure: 1 min, 2, 4… capped at 6 hours. */
export function backoffMs(failures: number): number {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

export async function createEndpoint(
  db: Db,
  p: { accountId: string; url: string; eventTypes: string[]; now: Date },
): Promise<EndpointRow> {
  const url = new URL(p.url);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new ApiError(
      400,
      "insecure_url",
      "webhook URLs must use https (http only for localhost)",
    );
  }
  // New endpoints start at the current head of the ledger: they get events from now on.
  const [head] = await db
    .select({ seq: schema.ledgerEntries.seq })
    .from(schema.ledgerEntries)
    .orderBy(desc(schema.ledgerEntries.seq))
    .limit(1);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      id: newId("webhookEndpoint", p.now.getTime()),
      accountId: p.accountId,
      url: url.toString(),
      secret: `whsec_pd_${randomBytes(24).toString("base64url")}`,
      eventTypes: p.eventTypes,
      cursorSeq: head?.seq ?? 0,
      createdAt: p.now,
      updatedAt: p.now,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function listEndpoints(db: Db, accountId: string) {
  return db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.accountId, accountId))
    .orderBy(asc(schema.webhookEndpoints.createdAt));
}

export async function deleteEndpoint(db: Db, accountId: string, id: string) {
  const owned = and(
    eq(schema.webhookEndpoints.id, id),
    eq(schema.webhookEndpoints.accountId, accountId),
  );
  const [row] = await db.select().from(schema.webhookEndpoints).where(owned).limit(1);
  if (!row) throw new ApiError(404, "not_found", "webhook endpoint not found");
  await db.delete(schema.webhookAttempts).where(eq(schema.webhookAttempts.endpointId, id));
  await db.delete(schema.webhookEndpoints).where(owned);
}

/** The JSON a platform receives: one ledger entry, with a stable id for de-duplication. */
export function eventBody(entry: typeof schema.ledgerEntries.$inferSelect) {
  return {
    id: `evt_${entry.seq}`,
    object: "event",
    type: entry.type,
    created_at: entry.createdAt,
    agreement_id: entry.agreementId,
    data: JSON.parse(entry.payload) as unknown,
    ledger: { seq: entry.seq, entry_hash: entry.entryHash },
  };
}

const wanted = (endpoint: EndpointRow, type: string) =>
  endpoint.eventTypes.length === 0 || endpoint.eventTypes.some((p) => type.startsWith(p));

/**
 * Delivers pending events to every due endpoint, in ledger order. An endpoint's cursor only
 * advances past an event once the endpoint answered 2xx, so delivery is at-least-once and
 * ordered; receivers de-duplicate on the event id. A failing endpoint backs off exponentially
 * and is disabled after 20 consecutive failures.
 */
export async function deliverWebhooks(
  db: Db,
  p: { now: Date; fetch?: typeof fetch },
): Promise<{ delivered: number; failed: string[] }> {
  const send = p.fetch ?? fetch;
  const endpoints = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.enabled, true),
        or(
          isNull(schema.webhookEndpoints.nextAttemptAt),
          lte(schema.webhookEndpoints.nextAttemptAt, p.now),
        ),
      ),
    );
  let delivered = 0;
  const failed: string[] = [];

  for (const endpoint of endpoints) {
    const entries = await db
      .select({ entry: schema.ledgerEntries })
      .from(schema.ledgerEntries)
      .innerJoin(schema.agreements, eq(schema.agreements.id, schema.ledgerEntries.agreementId))
      .where(
        and(
          eq(schema.agreements.accountId, endpoint.accountId),
          gt(schema.ledgerEntries.seq, endpoint.cursorSeq),
        ),
      )
      .orderBy(asc(schema.ledgerEntries.seq))
      .limit(BATCH);

    let cursor = endpoint.cursorSeq;
    let error: string | null = null;
    for (const { entry } of entries) {
      if (!wanted(endpoint, entry.type)) {
        cursor = entry.seq;
        continue;
      }
      const body = JSON.stringify(eventBody(entry));
      let status: number | null = null;
      try {
        const res = await send(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ProofDesk-Webhooks/1",
            "Proofdesk-Signature": signPayload(
              endpoint.secret,
              body,
              Math.floor(p.now.getTime() / 1000),
            ),
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await db.insert(schema.webhookAttempts).values({
        id: newId("webhookAttempt", p.now.getTime()),
        endpointId: endpoint.id,
        eventSeq: entry.seq,
        statusCode: status,
        error,
        createdAt: p.now,
      });
      if (error) break;
      cursor = entry.seq;
      delivered++;
    }

    const failures = error ? endpoint.failureCount + 1 : 0;
    await db
      .update(schema.webhookEndpoints)
      .set({
        cursorSeq: cursor,
        failureCount: failures,
        nextAttemptAt: error ? new Date(p.now.getTime() + backoffMs(failures)) : null,
        lastError: error,
        enabled: failures < MAX_FAILURES,
        updatedAt: p.now,
      })
      .where(eq(schema.webhookEndpoints.id, endpoint.id));
    if (error) failed.push(endpoint.id);
  }
  return { delivered, failed };
}

export async function recentAttempts(db: Db, endpointId: string, limit = 20) {
  return db
    .select()
    .from(schema.webhookAttempts)
    .where(eq(schema.webhookAttempts.endpointId, endpointId))
    .orderBy(desc(schema.webhookAttempts.createdAt))
    .limit(limit);
}
