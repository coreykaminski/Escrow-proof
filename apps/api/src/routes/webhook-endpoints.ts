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
} from "../services/webhooks.ts";

export const CreateEndpointBody = z.object({
  url: z.url().max(2000),
  /** Event type prefixes, e.g. ["agreement.decide", "hold."]; omit for all events. */
  event_types: z.array(z.string().min(1).max(100)).max(50).default([]),
});

/** Where a platform receives events about its agreements. */
export function webhookEndpointRoutes({ db, now }: AppDeps) {
  const r = new Hono<AppEnv>();

  r.post("/", async (c) => {
    const body = CreateEndpointBody.parse(await c.req.json());
    const row = await createEndpoint(db, {
      accountId: c.get("auth").accountId,
      url: body.url,
      eventTypes: body.event_types,
      now: now(),
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
