import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError, notFound } from "../errors.ts";
import { sellerJson, sellerWalletJson } from "../serialize.ts";
import { getSellerWallet, setSellerWallet } from "../services/onchain.ts";
import { getSeller, refreshSeller, startOnboarding } from "../services/payments.ts";
import { OnboardingBody, SellerWalletBody } from "./schemas.ts";

/**
 * Seller payout destinations, keyed by the platform's own seller_ref: a Stripe connected account
 * for card payouts, and/or a wallet address for stablecoin payouts.
 */
export function sellerRoutes({ db, now, payments, publicUrl }: AppDeps) {
  const r = new Hono<AppEnv>();
  const gateway = () => {
    if (!payments)
      throw new ApiError(503, "payments_unavailable", "card payments aren't configured");
    return payments;
  };

  /** Creates the seller's payout account if needed and returns a hosted onboarding link. */
  r.post("/:ref/onboarding", async (c) => {
    const body = OnboardingBody.parse(await c.req.json());
    const ref = c.req.param("ref");
    const base = publicUrl ?? "http://localhost:8787";
    const { seller, url } = await startOnboarding(db, gateway(), {
      accountId: c.get("auth").accountId,
      sellerRef: ref,
      country: body.country,
      email: body.email,
      returnUrl: body.return_url ?? `${base}/onboarding/done`,
      refreshUrl: body.refresh_url ?? `${base}/onboarding/refresh`,
      now: now(),
    });
    return c.json({ seller: sellerJson(seller), onboarding_url: url }, 201);
  });

  /** Sets the seller's USDC payout address (the provider on on-chain jobs). */
  r.put("/:ref/wallet", async (c) => {
    const body = SellerWalletBody.parse(await c.req.json());
    const row = await setSellerWallet(db, {
      accountId: c.get("auth").accountId,
      sellerRef: c.req.param("ref"),
      address: body.address,
      now: now(),
    });
    return c.json(sellerWalletJson(row));
  });

  r.get("/:ref/wallet", async (c) => {
    const row = await getSellerWallet(db, c.get("auth").accountId, c.req.param("ref"));
    if (!row) throw notFound("seller wallet");
    return c.json(sellerWalletJson(row));
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
