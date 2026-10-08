import type { Db } from "@proofdesk/db";
import { type DueResult, type Rails, runDue } from "./payments.ts";
import { deliverWebhooks } from "./webhooks.ts";

/**
 * One scheduler tick, safe to run as often as you like (every step is idempotent): payment
 * housekeeping first, then webhooks so platforms hear about what it changed.
 */
export async function tick(
  db: Db,
  deps: Rails & { fetch?: typeof fetch },
  now: Date,
): Promise<DueResult & { webhooks: { delivered: number; failed: string[] } }> {
  const due = await runDue(db, deps, now);
  const webhooks = await deliverWebhooks(db, { now, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  return { ...due, webhooks };
}
