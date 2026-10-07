import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError, notFound } from "../errors.ts";
import { sellerJson } from "../serialize.ts";
import { getSeller, refreshSeller, startOnboarding } from "../services/payments.ts";
import { OnboardingBody } from "./schemas.ts";

/** Seller payout accounts (Stripe Connect Express), keyed by the platform's own seller_ref. */
export function sellerRoutes({ db, now, payments, publicUrl }: AppDeps) {
  const r = new Hono<AppEnv>();
  const gateway = () => {
    if (!payments)
      throw new ApiError(503, "payments_unavailable", "card payments aren't configured");
    return payments;
  };

  /** Creates the seller's payout account if needed and returns a hosted onboarding link. */
  r.post("/:ref/onboarding", async (c) => {
    const body = OnboardingBody.parse(await c.req.json().catch(() => ({})));
    const ref = c.req.param("ref");
    const base = publicUrl ?? "http://localhost:8787";
    const { seller, url } = await startOnboarding(db, gateway(), {
      accountId: c.get("auth").accountId,
      sellerRef: ref,
      returnUrl: body.return_url ?? `${base}/onboarding/done`,
      refreshUrl: body.refresh_url ?? `${base}/onboarding/refresh`,
      now: now(),
    });
    return c.json({ seller: sellerJson(seller), onboarding_url: url }, 201);
  });

  r.get("/:ref", async (c) => {
    const seller = await getSeller(db, c.get("auth").accountId, c.req.param("ref"));
    if (!seller) throw notFound("seller");
    const fresh = payments
      ? await refreshSeller(db, payments, seller.stripeAccountId, now())
      : seller;
    return c.json(sellerJson(fresh ?? seller));
  });

  return r;
}
