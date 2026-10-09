import {
  billingPeriod,
  disputeFeeCents,
  newId,
  type Outcome,
  PRICING,
  periodRange,
  usdCents,
} from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema, type Tx } from "@proofdesk/db";
import type { PaymentsGateway } from "@proofdesk/payments";
import type { AnyReport } from "@proofdesk/verifier";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import type { AgreementRow } from "./agreements.ts";

/**
 * Proof Desk's own revenue:
 * - the conditional payment fee is kept inside each settlement (card: not transferred to the
 *   seller; on-chain: sent to the treasury by the contract);
 * - verification and dispute fees are recorded as usage events and invoiced monthly through
 *   Stripe Billing. Only live-mode usage is invoiced.
 */

const INVOICE_CURRENCY = "usd";
const DAYS_UNTIL_DUE = 14;

function verificationPrice(a: AgreementRow, report: AnyReport): { cents: number; label: string } {
  const v = a.spec.vertical;
  if (v === "code") return { cents: PRICING.verification.code, label: "code (sandboxed tests)" };
  if (v === "data") {
    const research =
      "vertical" in report && report.vertical === "data" && report.data.format === "markdown";
    return research
      ? { cents: PRICING.verification.research, label: "research (citations and quotes)" }
      : { cents: PRICING.verification.data, label: "structured data" };
  }
  return { cents: PRICING.verification.translation, label: "translation" };
}

/** Bills one verification run. Same transaction as the verification record; billed once. */
export async function recordVerificationFee(
  tx: Tx,
  p: { agreement: AgreementRow; verificationId: string; report: AnyReport; now: Date },
) {
  const price = verificationPrice(p.agreement, p.report);
  await tx
    .insert(schema.billingEvents)
    .values({
      id: newId("billingEvent", p.now.getTime()),
      accountId: p.agreement.accountId,
      kind: "verification",
      ref: p.verificationId,
      agreementId: p.agreement.id,
      livemode: p.agreement.livemode,
      amount: price.cents,
      description: `Verification: ${price.label}`,
      period: billingPeriod(p.now),
      occurredAt: p.now,
    })
    .onConflictDoNothing();
}

/** Bills a human dispute resolution: the higher of $25 or 5% of the amount. */
export async function recordDisputeFee(
  tx: Tx,
  p: { agreement: AgreementRow; ref: string; outcome: Outcome; now: Date },
) {
  const a = p.agreement;
  const fee = disputeFeeCents(a.amountValue, a.currency);
  const loser =
    p.outcome.kind === "release" ? "buyer" : p.outcome.kind === "refund" ? "seller" : "split";
  const approx = usdCents(a.amountValue, a.currency).exact ? "" : " (non-USD amount, approximate)";
  await tx
    .insert(schema.billingEvents)
    .values({
      id: newId("billingEvent", p.now.getTime()),
      accountId: a.accountId,
      kind: "dispute",
      ref: p.ref,
      agreementId: a.id,
      livemode: a.livemode,
      amount: fee,
      description: `Dispute resolution, ${a.id} (losing party: ${loser})${approx}`,
      period: billingPeriod(p.now),
      occurredAt: p.now,
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------------------------
// Usage report
// ---------------------------------------------------------------------------------------------

export async function usageReport(db: Db, accountId: string, period: string) {
  const [start, end] = periodRange(period);
  const events = await db
    .select()
    .from(schema.billingEvents)
    .where(
      and(eq(schema.billingEvents.accountId, accountId), eq(schema.billingEvents.period, period)),
    );
  const sum = (live: boolean, kind?: string) =>
    events
      .filter((e) => e.livemode === live && (!kind || e.kind === kind))
      .reduce((n, e) => n + e.amount, 0);

  // Conditional payment fees already kept at settlement this period (card + on-chain).
  const settled = await db
    .select({ agreement: schema.agreements, hold: schema.holds, job: schema.onchainJobs })
    .from(schema.agreements)
    .leftJoin(schema.holds, eq(schema.holds.agreementId, schema.agreements.id))
    .leftJoin(schema.onchainJobs, eq(schema.onchainJobs.agreementId, schema.agreements.id))
    .where(
      and(
        eq(schema.agreements.accountId, accountId),
        gte(schema.agreements.settledAt, start),
        lt(schema.agreements.settledAt, end),
      ),
    );
  let conditionalLive = 0;
  let conditionalTest = 0;
  for (const r of settled) {
    const fee = Number((r.hold?.settlement ?? r.job?.settlement)?.fee ?? 0);
    const cents = usdCents(fee, r.agreement.currency).cents;
    if (r.agreement.livemode) conditionalLive += cents;
    else conditionalTest += cents;
  }

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  const minimum = account?.plan === "verify_only" ? PRICING.verifyOnlyMonthlyMinimumCents : 0;
  const verificationLive = sum(true, "verification");
  return {
    object: "usage",
    period,
    currency: INVOICE_CURRENCY,
    plan: account?.plan ?? "standard",
    live: {
      verification_fees: verificationLive,
      dispute_fees: sum(true, "dispute"),
      /** Kept at settlement; not invoiced. */
      conditional_payment_fees_collected: conditionalLive,
      minimum_top_up: Math.max(0, minimum - verificationLive),
      invoiced_total: sum(true) + Math.max(0, minimum - verificationLive),
    },
    test: {
      verification_fees: sum(false, "verification"),
      dispute_fees: sum(false, "dispute"),
      conditional_payment_fees_collected: conditionalTest,
    },
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      agreement_id: e.agreementId,
      livemode: e.livemode,
      amount: e.amount,
      description: e.description,
      occurred_at: e.occurredAt.toISOString(),
      invoice_id: e.invoiceId,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Monthly invoicing
// ---------------------------------------------------------------------------------------------

export interface InvoiceRunResult {
  period: string;
  invoiced: { account_id: string; invoice_id: string; total: number }[];
  skipped: { account_id: string; reason: string }[];
}

/**
 * Invoices every account's unbilled live usage for a closed period. Safe to re-run: each
 * account's invoice uses a stable Stripe idempotency key and is recorded once per period.
 */
export async function invoicePeriod(
  db: Db,
  gw: PaymentsGateway,
  p: { period: string; now: Date },
): Promise<InvoiceRunResult> {
  const [, end] = periodRange(p.period);
  if (p.now.getTime() < end.getTime()) {
    throw new ApiError(409, "period_open", `${p.period} hasn't ended yet`);
  }
  const result: InvoiceRunResult = { period: p.period, invoiced: [], skipped: [] };
  const accounts = await db
    .selectDistinct({ accountId: schema.billingEvents.accountId })
    .from(schema.billingEvents)
    .where(
      and(
        eq(schema.billingEvents.period, p.period),
        eq(schema.billingEvents.livemode, true),
        isNull(schema.billingEvents.invoiceId),
      ),
    );
  const verifyOnly = await db
    .select({ accountId: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.plan, "verify_only"));
  const ids = new Set([...accounts.map((a) => a.accountId), ...verifyOnly.map((a) => a.accountId)]);

  for (const accountId of ids) {
    const [existing] = await db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.accountId, accountId), eq(schema.invoices.period, p.period)));
    if (existing) {
      result.skipped.push({ account_id: accountId, reason: "already invoiced" });
      continue;
    }
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId));
    if (!account?.billingEmail) {
      result.skipped.push({ account_id: accountId, reason: "no billing email" });
      continue;
    }
    const events = await db
      .select()
      .from(schema.billingEvents)
      .where(
        and(
          eq(schema.billingEvents.accountId, accountId),
          eq(schema.billingEvents.period, p.period),
          eq(schema.billingEvents.livemode, true),
          isNull(schema.billingEvents.invoiceId),
        ),
      );
    const lines = groupLines(events);
    const verification = events
      .filter((e) => e.kind === "verification")
      .reduce((n, e) => n + e.amount, 0);
    if (account.plan === "verify_only" && verification < PRICING.verifyOnlyMonthlyMinimumCents) {
      lines.push({
        description: "Verify plan monthly minimum (top-up)",
        amount: PRICING.verifyOnlyMonthlyMinimumCents - verification,
      });
    }
    const total = lines.reduce((n, l) => n + l.amount, 0);
    if (total === 0) {
      result.skipped.push({ account_id: accountId, reason: "nothing to invoice" });
      continue;
    }

    let customerId = account.stripeCustomerId;
    if (!customerId) {
      customerId = (
        await gw.createCustomer({
          accountId,
          name: account.name,
          email: account.billingEmail,
          idempotencyKey: `customer:${accountId}`,
        })
      ).id;
      await db
        .update(schema.accounts)
        .set({ stripeCustomerId: customerId })
        .where(eq(schema.accounts.id, accountId));
    }
    const inv = await gw.createInvoice({
      customerId,
      currency: INVOICE_CURRENCY,
      period: p.period,
      lines,
      daysUntilDue: DAYS_UNTIL_DUE,
      idempotencyKey: `invoice:${accountId}:${p.period}`,
    });
    const id = newId("invoice", p.now.getTime());
    await db.transaction(async (tx) => {
      await tx.insert(schema.invoices).values({
        id,
        accountId,
        period: p.period,
        stripeInvoiceId: inv.id,
        status: inv.status,
        total: inv.total,
        hostedUrl: inv.hostedUrl,
        lines,
        createdAt: p.now,
      });
      if (events.length > 0) {
        await tx
          .update(schema.billingEvents)
          .set({ invoiceId: id })
          .where(
            and(
              eq(schema.billingEvents.accountId, accountId),
              eq(schema.billingEvents.period, p.period),
              eq(schema.billingEvents.livemode, true),
              isNull(schema.billingEvents.invoiceId),
              inArray(
                schema.billingEvents.id,
                events.map((e) => e.id),
              ),
            ),
          );
      }
      await appendLedgerEntry(tx, {
        agreementId: null,
        type: "billing.invoiced",
        payload: {
          account_id: accountId,
          period: p.period,
          invoice_id: id,
          stripe_invoice_id: inv.id,
          total: inv.total,
        },
        createdAt: p.now,
      });
    });
    result.invoiced.push({ account_id: accountId, invoice_id: id, total: inv.total });
  }
  return result;
}

/** One line per kind and unit price, e.g. "Verification: translation × 12". */
function groupLines(events: (typeof schema.billingEvents.$inferSelect)[]) {
  const groups = new Map<string, { label: string; count: number; amount: number; unit: number }>();
  for (const e of events) {
    if (e.kind === "dispute") {
      groups.set(e.id, { label: e.description, count: 1, amount: e.amount, unit: e.amount });
      continue;
    }
    const key = `${e.description}@${e.amount}`;
    const g = groups.get(key) ?? { label: e.description, count: 0, amount: 0, unit: e.amount };
    g.count++;
    g.amount += e.amount;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    description: g.count > 1 ? `${g.label} × ${g.count} @ $${(g.unit / 100).toFixed(2)}` : g.label,
    amount: g.amount,
  }));
}

// ---------------------------------------------------------------------------------------------
// Reviewer payouts
// ---------------------------------------------------------------------------------------------

/** A reviewer's payout account is a seller account under their ops account. */
export const reviewerRef = (apiKeyId: string) => `reviewer:${apiKeyId}`;

/**
 * What a reviewer earns, in the currency payouts are made in. Transfers from the platform
 * balance must be in the platform's settlement currency (CAD for a Canadian account).
 */
export interface ReviewerRates {
  currency: string;
  decision: number;
  disputeResolution: number;
}

export const DEFAULT_REVIEWER_RATES: ReviewerRates = {
  currency: "usd",
  decision: PRICING.reviewer.decisionCents,
  disputeResolution: PRICING.reviewer.disputeResolutionCents,
};

export interface PayoutRunResult {
  period: string;
  paid: { api_key_id: string; reviewer: string; amount: number; transfer_id: string }[];
  failed: { api_key_id: string; reviewer: string; amount: number; error: string }[];
  skipped: { api_key_id: string; reason: string }[];
}

/**
 * Each reviewer's paid work in [start, end): human decisions and shadow reviews (an override is
 * both a decision and a review, so it's counted once, as a review), and dispute resolutions.
 */
async function reviewerWork(db: Db, start: Date, end: Date) {
  const decisions = await db
    .select({ apiKeyId: schema.decisions.actorRef, kind: schema.decisions.kind })
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.decidedBy, "human"),
        gte(schema.decisions.createdAt, start),
        lt(schema.decisions.createdAt, end),
      ),
    );
  const reviews = await db
    .select({ apiKeyId: schema.decisionReviews.reviewerRef })
    .from(schema.decisionReviews)
    .where(
      and(gte(schema.decisionReviews.createdAt, start), lt(schema.decisionReviews.createdAt, end)),
    );
  const byKey = new Map<string, { decisions: number; resolutions: number }>();
  const entry = (k: string) => {
    const e = byKey.get(k) ?? { decisions: 0, resolutions: 0 };
    byKey.set(k, e);
    return e;
  };
  for (const d of decisions) {
    if (d.kind === "dispute_resolution") entry(d.apiKeyId).resolutions++;
    else if (d.kind !== "review_override") entry(d.apiKeyId).decisions++;
  }
  for (const r of reviews) entry(r.apiKeyId).decisions++;
  if (byKey.size === 0) return [];
  const names = await db
    .select({ id: schema.apiKeys.id, name: schema.accounts.name })
    .from(schema.apiKeys)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.apiKeys.accountId))
    .where(inArray(schema.apiKeys.id, [...byKey.keys()]));
  return [...byKey].map(([apiKeyId, w]) => ({
    apiKeyId,
    reviewer: names.find((n) => n.id === apiKeyId)?.name ?? apiKeyId,
    ...w,
  }));
}

/**
 * Pays each human reviewer for a closed period: a rate per decision or shadow review and per
 * dispute resolution (`rates`, default PRICING.reviewer), transferred to their connected account. A payout is recorded once per
 * reviewer per period; a failed one (e.g. onboarding unfinished) is retried on the next run.
 */
export async function payReviewers(
  db: Db,
  gw: PaymentsGateway,
  p: { period: string; now: Date; rates?: ReviewerRates },
): Promise<PayoutRunResult> {
  const [start, end] = periodRange(p.period);
  if (p.now.getTime() < end.getTime()) {
    throw new ApiError(409, "period_open", `${p.period} hasn't ended yet`);
  }
  const rates = p.rates ?? DEFAULT_REVIEWER_RATES;
  const currency = rates.currency;
  const result: PayoutRunResult = { period: p.period, paid: [], failed: [], skipped: [] };
  const work = await reviewerWork(db, start, end);
  for (const s of work) {
    const { decisions, resolutions } = s;
    const amount = decisions * rates.decision + resolutions * rates.disputeResolution;

    const [prior] = await db
      .select()
      .from(schema.reviewerPayouts)
      .where(
        and(
          eq(schema.reviewerPayouts.apiKeyId, s.apiKeyId),
          eq(schema.reviewerPayouts.period, p.period),
        ),
      );
    if (prior?.status === "paid") {
      result.skipped.push({ api_key_id: s.apiKeyId, reason: "already paid" });
      continue;
    }
    const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, s.apiKeyId));
    const [acct] = key
      ? await db
          .select()
          .from(schema.sellerAccounts)
          .where(
            and(
              eq(schema.sellerAccounts.accountId, key.accountId),
              eq(schema.sellerAccounts.sellerRef, reviewerRef(s.apiKeyId)),
            ),
          )
      : [];
    const record = async (row: {
      status: "paid" | "failed";
      transferId?: string;
      error?: string;
      destination: string;
    }) => {
      const values = {
        decisions,
        disputeResolutions: resolutions,
        amount,
        currency,
        destination: row.destination,
        transferId: row.transferId ?? null,
        status: row.status,
        error: row.error ?? null,
      };
      await db
        .insert(schema.reviewerPayouts)
        .values({
          id: newId("reviewerPayout", p.now.getTime()),
          apiKeyId: s.apiKeyId,
          period: p.period,
          createdAt: p.now,
          ...values,
        })
        .onConflictDoUpdate({
          target: [schema.reviewerPayouts.apiKeyId, schema.reviewerPayouts.period],
          set: values,
        });
    };
    if (!acct) {
      const error =
        "no payout account; the reviewer must onboard with POST /v1/ops/reviewers/me/onboarding";
      await record({ status: "failed", error, destination: "" });
      result.failed.push({ api_key_id: s.apiKeyId, reviewer: s.reviewer, amount, error });
      continue;
    }
    try {
      const t = await gw.payout({
        amount,
        currency,
        destination: acct.stripeAccountId,
        description: `Proof Desk reviews, ${p.period}: ${decisions} decisions and reviews, ${resolutions} dispute resolutions`,
        idempotencyKey: `reviewer-payout:${s.apiKeyId}:${p.period}`,
      });
      await record({ status: "paid", transferId: t.id, destination: acct.stripeAccountId });
      result.paid.push({ api_key_id: s.apiKeyId, reviewer: s.reviewer, amount, transfer_id: t.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await record({ status: "failed", error, destination: acct.stripeAccountId });
      result.failed.push({ api_key_id: s.apiKeyId, reviewer: s.reviewer, amount, error });
    }
  }
  return result;
}
