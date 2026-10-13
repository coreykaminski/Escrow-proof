import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";
import { webhookEndpointJson } from "../serialize.ts";
import {
  createEndpoint,
  deleteEndpoint,
  listEndpoints,
  recentAttempts,
  replayEndpoint,
  sendTestEvent,
} from "../services/webhooks.ts";

export const CreateEndpointBody = z.object({
  url: z.url().max(2000),
  /** Event type prefixes, e.g. ["agreement.decide", "hold."]; omit for all events. */
  event_types: z.array(z.string().min(1).max(100)).max(50).default([]),
});

export const ReplayBody = z.object({
  /** Re-send events from this one onward ("evt_123" or its ledger seq 123). */
  from_event: z.union([z.string().regex(/^evt_\d+$/), z.number().int().min(1)]),
});

/** Where a platform receives events about its agreements. */
export function webhookEndpointRoutes({ db, now, allowPrivateNetwork, fetch }: AppDeps) {
  const r = new Hono<AppEnv>();

  /** Sends a signed `webhook.test` event now, to check the receiver end to end. */
  r.post("/:id/test", async (c) =>
    c.json(
      await sendTestEvent(db, {
        accountId: c.get("auth").accountId,
        endpointId: c.req.param("id"),
        now: now(),
        allowPrivate: allowPrivateNetwork === true,
        ...(fetch ? { fetch } : {}),
      }),
    ),
  );

  /** Re-sends events from a point (after an outage), and re-enables a disabled endpoint. */
  r.post("/:id/replay", async (c) => {
    const body = ReplayBody.parse(await c.req.json());
    const fromSeq =
      typeof body.from_event === "number" ? body.from_event : Number(body.from_event.slice(4));
    const row = await replayEndpoint(db, {
      accountId: c.get("auth").accountId,
      endpointId: c.req.param("id"),
      fromSeq,
      now: now(),
    });
    return c.json(webhookEndpointJson(row));
  });

  r.post("/", async (c) => {
    const body = CreateEndpointBody.parse(await c.req.json());
    const row = await createEndpoint(db, {
      accountId: c.get("auth").accountId,
      url: body.url,
      eventTypes: body.event_types,
      now: now(),
      allowPrivate: allowPrivateNetwork === true,
    });
    // The signing secret is shown once, at creation.
    return c.json({ ...webhookEndpointJson(row), secret: row.secret }, 201);
  });

  r.get("/", async (c) => {
    const rows = await listEndpoints(db, c.get("auth").accountId);
    return c.json({ object: "list", data: rows.map(webhookEndpointJson) });
  });

  r.get("/:id/attempts", async (c) => {
    const id = c.req.param("id");
    const owned = (await listEndpoints(db, c.get("auth").accountId)).some((e) => e.id === id);
    if (!owned) throw new ApiError(404, "not_found", "webhook endpoint not found");
    const rows = await recentAttempts(db, id);
    return c.json({
      object: "list",
      data: rows.map((a) => ({
        event_id: `evt_${a.eventSeq}`,
        status_code: a.statusCode,
        error: a.error,
        created_at: a.createdAt.toISOString(),
      })),
    });
  });

  r.delete("/:id", async (c) => {
    await deleteEndpoint(db, c.get("auth").accountId, c.req.param("id"));
    return c.json({ deleted: true });
  });

  return r;
}
