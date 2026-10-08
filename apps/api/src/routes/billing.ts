import { billingPeriod, periodRange } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";
import { sellerJson } from "../serialize.ts";
import { invoicePeriod, payReviewers, reviewerRef, usageReport } from "../services/billing.ts";
import { startOnboarding } from "../services/payments.ts";

const period = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM")
  .refine((p) => {
    periodRange(p);
    return true;
  });

export const BillingSettingsBody = z.object({ email: z.email() });
export const PeriodBody = z.object({ period });
export const PlanBody = z.object({ plan: z.enum(["standard", "verify_only"]) });
export const ReviewerOnboardingBody = z.object({
  email: z.email(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default("us"),
  return_url: z.url().optional(),
  refresh_url: z.url().optional(),
});

const invoiceJson = (r: typeof schema.invoices.$inferSelect) => ({
  id: r.id,
  object: "invoice",
  period: r.period,
  status: r.status,
  total: { value: r.total, currency: "usd" },
  hosted_url: r.hostedUrl,
  lines: r.lines,
  created_at: r.createdAt.toISOString(),
});

/** A platform's usage, invoices and billing contact. */
export function billingRoutes({ db, now }: AppDeps) {
  const r = new Hono<AppEnv>();

  r.get("/usage", async (c) => {
    const p = period.parse(c.req.query("period") ?? billingPeriod(now()));
    return c.json(await usageReport(db, c.get("auth").accountId, p));
  });

  r.get("/invoices", async (c) => {
    const rows = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.accountId, c.get("auth").accountId))
      .orderBy(desc(schema.invoices.period));
    return c.json({ object: "list", data: rows.map(invoiceJson) });
  });

  r.put("/settings", async (c) => {
    const body = BillingSettingsBody.parse(await c.req.json());
    const [row] = await db
      .update(schema.accounts)
      .set({ billingEmail: body.email })
      .where(eq(schema.accounts.id, c.get("auth").accountId))
      .returning();
    return c.json({ object: "billing_settings", email: row?.billingEmail, plan: row?.plan });
  });

  return r;
}

/** Ops: month-end invoicing, reviewer payouts, plans, and reviewers' own payout onboarding. */
export function opsBillingRoutes({ db, now, payments, publicUrl, reviewerRates }: AppDeps) {
  const r = new Hono<AppEnv>();
  const gateway = () => {
    if (!payments) throw new ApiError(503, "payments_unavailable", "Stripe isn't configured");
    return payments;
  };

  r.post("/billing/invoice", async (c) => {
    const body = PeriodBody.parse(await c.req.json());
    return c.json(await invoicePeriod(db, gateway(), { period: body.period, now: now() }));
  });

  r.post("/billing/reviewer-payouts", async (c) => {
    const body = PeriodBody.parse(await c.req.json());
    return c.json(
      await payReviewers(db, gateway(), {
        period: body.period,
        now: now(),
        ...(reviewerRates ? { rates: reviewerRates } : {}),
      }),
    );
  });

  r.put("/accounts/:id/plan", async (c) => {
    const body = PlanBody.parse(await c.req.json());
    const [row] = await db
      .update(schema.accounts)
      .set({ plan: body.plan })
      .where(eq(schema.accounts.id, c.req.param("id")))
      .returning();
    if (!row) throw new ApiError(404, "not_found", "account not found");
    return c.json({ id: row.id, object: "account", name: row.name, plan: row.plan });
  });

  /** A reviewer (any ops key) links the Stripe account their review payouts go to. */
  r.post("/reviewers/me/onboarding", async (c) => {
    const body = ReviewerOnboardingBody.parse(await c.req.json());
    const auth = c.get("auth");
    const base = publicUrl ?? "http://localhost:8787";
    const { seller, url } = await startOnboarding(db, gateway(), {
      accountId: auth.accountId,
      sellerRef: reviewerRef(auth.apiKeyId),
      country: body.country,
      email: body.email,
      returnUrl: body.return_url ?? `${base}/onboarding/done`,
      refreshUrl: body.refresh_url ?? `${base}/onboarding/refresh`,
      now: now(),
    });
    return c.json({ payout_account: sellerJson(seller), onboarding_url: url }, 201);
  });

  return r;
}
