import type { Db } from "@proofdesk/db";
import type { PaymentsGateway } from "@proofdesk/payments";
import { type DueResult, runDue } from "./payments.ts";
import { deliverWebhooks } from "./webhooks.ts";

/**
 * One scheduler tick, safe to run as often as you like (every step is idempotent): payment
 * housekeeping first, then webhooks so platforms hear about what it changed.
 */
export async function tick(
  db: Db,
  deps: { payments?: PaymentsGateway; fetch?: typeof fetch },
  now: Date,
): Promise<DueResult & { webhooks: { delivered: number; failed: string[] } }> {
  const due = await runDue(db, deps.payments, now);
  const webhooks = await deliverWebhooks(db, { now, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  return { ...due, webhooks };
}
