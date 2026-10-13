import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../env.ts";
import { listEvents } from "../services/webhooks.ts";

const EventsQuery = z.object({
  /** Return events after this one ("evt_123" or 123); omit to start from the beginning. */
  after: z.union([z.string().regex(/^evt_\d+$/), z.coerce.number().int().min(0)]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Event type prefix, e.g. "agreement.decide" or "hold.". */
  type: z.string().min(1).max(100).optional(),
});

/** The same events webhooks deliver, for backfilling after an outage or polling instead. */
export function eventRoutes({ db }: AppDeps) {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const q = EventsQuery.parse(c.req.query());
    const after =
      q.after === undefined ? 0 : typeof q.after === "number" ? q.after : Number(q.after.slice(4));
    const data = await listEvents(db, {
      accountId: c.get("auth").accountId,
      after,
      limit: q.limit,
      ...(q.type ? { type: q.type } : {}),
    });
    return c.json({ object: "list", data, next_after: data.at(-1)?.id ?? null });
  });
  return r;
}
