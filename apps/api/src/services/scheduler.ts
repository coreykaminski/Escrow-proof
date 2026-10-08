import type { Db } from "@proofdesk/db";
import { type DueResult, type Rails, runDue } from "./payments.ts";
import { setState } from "./status.ts";
import { deliverWebhooks } from "./webhooks.ts";

/**
 * One scheduler tick, safe to run as often as you like (every step is idempotent): payment
 * housekeeping first, then webhooks so platforms hear about what it changed.
 */
export async function tick(
  db: Db,
  deps: Rails & { fetch?: typeof fetch; allowPrivateNetwork?: boolean },
  now: Date,
): Promise<DueResult & { webhooks: { delivered: number; failed: string[] } }> {
  const due = await runDue(db, deps, now);
  const webhooks = await deliverWebhooks(db, {
    now,
    allowPrivate: deps.allowPrivateNetwork === true,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  await setState(
    db,
    "scheduler.tick",
    {
      settled: due.settled.length,
      deadlines_missed: due.deadlines_missed.length,
      errors: due.errors.length,
      webhooks_delivered: webhooks.delivered,
    },
    now,
  );
  return { ...due, webhooks };
}
