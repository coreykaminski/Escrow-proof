import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";
import { handleWebhook } from "../services/payments.ts";

/** Processor webhooks. Authenticated by signature, not API key. */
export function webhookRoutes({ db, now, payments }: AppDeps) {
  const r = new Hono<AppEnv>();
  r.post("/stripe", async (c) => {
    if (!payments)
      throw new ApiError(503, "payments_unavailable", "card payments aren't configured");
    const result = await handleWebhook(db, payments, {
      rawBody: await c.req.text(),
      signature: c.req.header("Stripe-Signature") ?? "",
      now: now(),
    });
    return c.json({ received: true, ...result });
  });
  return r;
}
