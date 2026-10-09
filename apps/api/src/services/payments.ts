import type { ChainGateway } from "@proofdesk/chain";
import { type Actor, newId, TransitionError, transition } from "@proofdesk/core";
import { appendLedgerEntry, type Db, type HoldStatus, schema, type Tx } from "@proofdesk/db";
import {
  GatewayError,
  type HoldState,
  needsExtendedAuthorization,
  type PaymentsGateway,
  planSettlement,
  SettlementError,
  WebhookSignatureError,
} from "@proofdesk/payments";
import { and, eq, inArray, lt } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import {
  type AgreementRow,
  applyEvent,
  assertDirectHoldAllowed,
  getAgreement,
  type Scope,
  snapshotOf,
} from "./agreements.ts";
import {
  chainUnavailable,
  expiringOnchainJobs,
  getOnchainJob,
  settleOnchain,
  syncOnchainJobs,
} from "./onchain.ts";

/** The money rails a deployment has configured. */
export interface Rails {
  payments?: PaymentsGateway | undefined;
  chain?: ChainGateway | undefined;
}

export type HoldRow = typeof schema.holds.$inferSelect;
export type SellerRow = typeof schema.sellerAccounts.$inferSelect;

const SYSTEM: Actor = { role: "system", ref: "payments" };

// ---------------------------------------------------------------------------------------------
// Sellers (Stripe Connect Express)
// ---------------------------------------------------------------------------------------------

export async function getSeller(db: Db, accountId: string, sellerRef: string) {
  const [row] = await db
    .select()
    .from(schema.sellerAccounts)
    .where(
      and(
        eq(schema.sellerAccounts.accountId, accountId),
        eq(schema.sellerAccounts.sellerRef, sellerRef),
      ),
    )
    .limit(1);
  return row;
}

/** Creates the seller's connected account on first use; returns it plus a fresh onboarding link. */
export async function startOnboarding(
  db: Db,
  gw: PaymentsGateway,
  p: {
    accountId: string;
    sellerRef: string;
    country: string;
    email: string;
    refreshUrl: string;
    returnUrl: string;
    now: Date;
  },
): Promise<{ seller: SellerRow; url: string }> {
  let seller = await getSeller(db, p.accountId, p.sellerRef);
  if (!seller) {
    const account = await gw.createSellerAccount({
      sellerRef: p.sellerRef,
      country: p.country,
      email: p.email,
      idempotencyKey: `seller:${p.accountId}:${p.sellerRef}`,
    });
    await db
      .insert(schema.sellerAccounts)
      .values({
        id: newId("seller", p.now.getTime()),
        accountId: p.accountId,
        sellerRef: p.sellerRef,
        stripeAccountId: account.id,
        detailsSubmitted: account.details_submitted,
        transfersActive: account.transfers_active,
        payoutsEnabled: account.payouts_enabled,
        createdAt: p.now,
        updatedAt: p.now,
      })
      .onConflictDoNothing();
    seller = await getSeller(db, p.accountId, p.sellerRef);
    if (!seller) throw new Error("seller account insert failed");
  }
  const { url } = await gw.createOnboardingLink({
    accountId: seller.stripeAccountId,
    refreshUrl: p.refreshUrl,
    returnUrl: p.returnUrl,
  });
  return { seller, url };
}

/** Re-reads a connected account's capabilities (on account.updated, and before paying out). */
export async function refreshSeller(
  db: Db,
  gw: PaymentsGateway,
  stripeAccountId: string,
  now: Date,
) {
  const a = await gw.getSellerAccount(stripeAccountId);
  const [row] = await db
    .update(schema.sellerAccounts)
    .set({
      detailsSubmitted: a.details_submitted,
      transfersActive: a.transfers_active,
      payoutsEnabled: a.payouts_enabled,
      updatedAt: now,
    })
    .where(eq(schema.sellerAccounts.stripeAccountId, stripeAccountId))
    .returning();
  return row;
}

// ---------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------

export async function getHold(db: Db, agreementId: string) {
  const [row] = await db
    .select()
    .from(schema.holds)
    .where(eq(schema.holds.agreementId, agreementId))
    .limit(1);
  return row;
}

/**
 * Authorizes the buyer's card for the agreement amount. With a payment method the hold is
 * confirmed immediately (agent and server-side flows); otherwise the client confirms it with the
 * returned client_secret and the webhook completes funding.
 */
/**
 * An agent's shared payment token must cover this exact hold: same currency, a limit at least
 * the agreement amount, still active and unexpired. Checked before Stripe is asked to charge it.
 */
async function checkSharedPaymentToken(
  gw: PaymentsGateway,
  id: string,
  agreement: AgreementRow,
  now: Date,
) {
  let token: Awaited<ReturnType<PaymentsGateway["getSharedPaymentToken"]>>;
  try {
    token = await gw.getSharedPaymentToken(id);
  } catch (err) {
    if (err instanceof GatewayError && !err.retryable) {
      throw new ApiError(422, "shared_payment_token_rejected", err.message);
    }
    throw err;
  }
  const problems = [
    !token.active && "it is no longer active (used, expired or revoked)",
    token.expires_at !== null && token.expires_at.getTime() <= now.getTime() && "it has expired",
    token.currency.toLowerCase() !== agreement.currency.toLowerCase() &&
      `it is for ${token.currency.toUpperCase()}, the agreement is in ${agreement.currency.toUpperCase()}`,
    token.max_amount < agreement.amountValue &&
      `its limit (${token.max_amount}) is below the agreement amount (${agreement.amountValue})`,
  ].filter((x): x is string => typeof x === "string");
  if (problems.length > 0) {
    throw new ApiError(
      422,
      "shared_payment_token_rejected",
      `can't fund with this shared payment token: ${problems.join("; ")}`,
    );
  }
}

export async function createCardHold(
  db: Db,
  gw: PaymentsGateway,
  p: {
    agreementId: string;
    scope: Scope;
    paymentMethod?: string;
    /** An MPP/ACP agent's shared payment token (spt_…), checked against the agreement first. */
    sharedPaymentToken?: string;
    now: Date;
  },
): Promise<{ hold: HoldRow; state: HoldState; agreement: AgreementRow }> {
  const agreement = await getAgreement(db, p.agreementId, p.scope);
  if (agreement.livemode !== (gw.mode === "live")) {
    throw new ApiError(
      400,
      "livemode_mismatch",
      `a ${agreement.livemode ? "live" : "test"} agreement can't use the ${gw.mode} card processor`,
    );
  }
  if (await getOnchainJob(db, agreement.id)) {
    throw new ApiError(409, "already_funding", "this agreement is being funded on-chain");
  }
  const existing = await getHold(db, agreement.id);
  if (existing) {
    const state = await gw.getHold(existing.paymentIntentId);
    return { hold: existing, state, agreement };
  }
  if (agreement.status !== "spec_approved") {
    throw new ApiError(
      409,
      "invalid_transition",
      `can't fund an agreement in status "${agreement.status}"`,
    );
  }
  assertDirectHoldAllowed(agreement);
  const seller = await getSeller(db, agreement.accountId, agreement.sellerRef);
  if (!seller) {
    throw new ApiError(
      409,
      "seller_not_onboarded",
      `seller "${agreement.sellerRef}" has no payout account; start onboarding with POST /v1/sellers/${encodeURIComponent(agreement.sellerRef)}/onboarding`,
    );
  }

  if (p.sharedPaymentToken)
    await checkSharedPaymentToken(gw, p.sharedPaymentToken, agreement, p.now);

  let state: HoldState;
  try {
    state = await gw.createHold({
      amount: agreement.amountValue,
      currency: agreement.currency,
      agreementId: agreement.id,
      description: agreement.spec.title.slice(0, 200),
      extendedAuthorization: needsExtendedAuthorization(
        p.now,
        agreement.deliveryDueAt,
        agreement.appealWindowHours,
      ),
      idempotencyKey: `hold:${agreement.id}`,
      ...(p.paymentMethod ? { paymentMethod: p.paymentMethod } : {}),
      ...(p.sharedPaymentToken ? { sharedPaymentToken: p.sharedPaymentToken } : {}),
    });
  } catch (err) {
    if (err instanceof GatewayError && err.code === "card_declined") {
      throw new ApiError(402, "card_declined", err.message);
    }
    if (err instanceof GatewayError && !err.retryable && p.sharedPaymentToken) {
      throw new ApiError(422, "shared_payment_token_rejected", err.message);
    }
    throw err;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(schema.holds)
      .values({
        id: newId("hold", p.now.getTime()),
        agreementId: agreement.id,
        rail: "card",
        paymentIntentId: state.id,
        status: "pending",
        amount: state.amount,
        currency: state.currency,
        createdAt: p.now,
        updatedAt: p.now,
      })
      .onConflictDoNothing();
    await appendLedgerEntry(tx, {
      agreementId: agreement.id,
      type: "hold.created",
      payload: { payment_intent_id: state.id, amount: state.amount, currency: state.currency },
      createdAt: p.now,
    });
  });
  await syncHold(db, gw, state.id, p.now);
  const hold = (await getHold(db, agreement.id)) as HoldRow;
  return {
    hold,
    state: await gw.getHold(state.id),
    agreement: await getAgreement(db, agreement.id, {}),
  };
}

function nextStatus(row: HoldRow, s: HoldState): HoldStatus {
  if (row.status === "settled") return "settled";
  switch (s.status) {
    case "requires_capture":
      return "authorized";
    case "succeeded":
      return "captured";
    case "canceled":
      return row.status === "authorized" && s.cancellation_reason === "automatic"
        ? "expired"
        : "canceled";
    default:
      return row.status === "pending" ? "pending" : row.status;
  }
}

/**
 * Brings our hold in line with the processor's current state. Always re-reads the payment intent,
 * so webhooks can arrive late, twice, or out of order. A newly authorized hold funds the agreement.
 */
export async function syncHold(db: Db, gw: PaymentsGateway, paymentIntentId: string, now: Date) {
  const [row] = await db
    .select()
    .from(schema.holds)
    .where(eq(schema.holds.paymentIntentId, paymentIntentId))
    .limit(1);
  if (!row) return { changed: false };
  const s = await gw.getHold(paymentIntentId);
  const status = nextStatus(row, s);
  const patch = {
    status,
    chargeId: s.charge_id,
    captureBefore: s.capture_before,
    extended: s.extended,
    capturedAmount: s.amount_received,
    updatedAt: now,
  };
  const update = (tx: Tx) => tx.update(schema.holds).set(patch).where(eq(schema.holds.id, row.id));

  const agreement = await getAgreement(db, row.agreementId, {});
  if (status === "authorized" && agreement.status === "spec_approved") {
    try {
      await applyEvent(db, {
        agreementId: row.agreementId,
        scope: {},
        event: { type: "FUND", rail: "card", holdRef: paymentIntentId },
        actor: SYSTEM,
        now,
        afterTransition: async (tx) => {
          await update(tx);
        },
      });
      return { changed: true, funded: true };
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      if (err.code === "deadline_passed") {
        // Confirmed too late to fund: release the authorization rather than hold the card.
        await gw.cancel(paymentIntentId, `late:${row.agreementId}`);
        return syncHold(db, gw, paymentIntentId, now);
      }
      // invalid_transition: a concurrent sync funded it first.
      if (err.code !== "invalid_transition") throw err;
    }
  }
  if (
    status === row.status &&
    s.amount_received === row.capturedAmount &&
    s.charge_id === row.chargeId
  ) {
    return { changed: false };
  }
  await db.transaction(async (tx) => {
    await update(tx);
    if (
      status !== row.status &&
      (status === "expired" || status === "canceled" || status === "captured")
    ) {
      await appendLedgerEntry(tx, {
        agreementId: row.agreementId,
        type: `hold.${status}`,
        payload: {
          payment_intent_id: paymentIntentId,
          previous_status: row.status,
          amount_received: s.amount_received,
        },
        createdAt: now,
      });
    }
  });
  return { changed: true };
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/**
 * Verifies and processes one webhook delivery exactly once. If processing fails, the delivery
 * is forgotten so the processor's retry runs it again.
 */
export async function handleWebhook(
  db: Db,
  gw: PaymentsGateway,
  p: { rawBody: string; signature: string; now: Date },
): Promise<{ status: "processed" | "duplicate" | "ignored"; type?: string }> {
  let event: ReturnType<PaymentsGateway["parseWebhook"]>;
  try {
    event = gw.parseWebhook(p.rawBody, p.signature);
  } catch (err) {
    if (err instanceof WebhookSignatureError)
      throw new ApiError(400, "invalid_signature", err.message);
    throw err;
  }
  if (event.livemode !== (gw.mode === "live")) return { status: "ignored", type: event.type };

  const claimed = await db
    .insert(schema.webhookEvents)
    .values({ id: event.id, provider: "stripe", type: event.type, receivedAt: p.now })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.id });
  if (claimed.length === 0) return { status: "duplicate", type: event.type };

  try {
    if (event.type.startsWith("payment_intent.")) {
      await syncHold(db, gw, event.object_id, p.now);
    } else if (event.type === "account.updated") {
      await refreshSeller(db, gw, event.object_id, p.now);
    } else if (event.type === "charge.dispute.created" && event.payment_intent_id) {
      await recordChargeback(db, event.payment_intent_id, event.object_id, p.now);
    } else {
      return { status: "ignored", type: event.type };
    }
    return { status: "processed", type: event.type };
  } catch (err) {
    await db.delete(schema.webhookEvents).where(eq(schema.webhookEvents.id, event.id));
    throw err;
  }
}

/** A card chargeback bypasses our decision; flag it for ops and record it on the ledger. */
async function recordChargeback(db: Db, paymentIntentId: string, disputeId: string, now: Date) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.holds)
      .set({ disputed: true, updatedAt: now })
      .where(eq(schema.holds.paymentIntentId, paymentIntentId))
      .returning();
    if (!row) return;
    await appendLedgerEntry(tx, {
      agreementId: row.agreementId,
      type: "hold.chargeback_opened",
      payload: { payment_intent_id: paymentIntentId, dispute_id: disputeId },
      createdAt: now,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------------------------

/**
 * Moves the money for a final decision, then marks the agreement settled. Eligibility (appeal
 * window, status) is checked before any money moves; each money movement carries a stable
 * idempotency key, so a retry after a partial failure finishes the job without repeating it.
 */
export async function settleAgreement(
  db: Db,
  rails: Rails,
  p: { agreementId: string; actor: Actor; force: boolean; settlementRef?: string; now: Date },
): Promise<AgreementRow> {
  const agreement = await getAgreement(db, p.agreementId, {});
  if (agreement.holdRail === "onchain") {
    if (!rails.chain) chainUnavailable();
    return settleOnchain(db, rails.chain, {
      agreement,
      actor: p.actor,
      force: p.force,
      now: p.now,
    });
  }
  const gw = rails.payments;
  if (agreement.holdRail !== "card") {
    if (!p.settlementRef) {
      throw new ApiError(400, "validation_error", "settlement_ref is required for the test rail");
    }
    return applyEvent(db, {
      agreementId: agreement.id,
      scope: {},
      event: { type: "SETTLE", settlementRef: p.settlementRef, force: p.force },
      actor: p.actor,
      now: p.now,
    });
  }
  if (!gw) throw new ApiError(503, "payments_unavailable", "card payments aren't configured");

  // Dry-run the transition: refuse before touching money if settling isn't allowed yet.
  transition(
    snapshotOf(agreement),
    { type: "SETTLE", settlementRef: "pending", force: p.force },
    p.actor,
    p.now,
  );
  const outcome = agreement.outcome;
  const hold = await getHold(db, agreement.id);
  if (!outcome || !hold) throw new ApiError(409, "invalid_transition", "nothing to settle");
  if (hold.disputed) {
    throw new ApiError(
      409,
      "hold_disputed",
      "the card payment has an open chargeback; ops must resolve it",
    );
  }

  let state = await gw.getHold(hold.paymentIntentId);
  let plan: ReturnType<typeof planSettlement>;
  try {
    plan = planSettlement(agreement.id, state, outcome);
  } catch (err) {
    if (err instanceof SettlementError) throw new ApiError(409, "hold_unsettleable", err.message);
    throw err;
  }

  const seller = await getSeller(db, agreement.accountId, agreement.sellerRef);
  if (plan.steps.some((s) => s.op === "transfer")) {
    const fresh = seller && (await refreshSeller(db, gw, seller.stripeAccountId, p.now));
    if (!fresh?.transfersActive) {
      throw new ApiError(
        409,
        "seller_not_ready",
        `seller "${agreement.sellerRef}" hasn't finished payout onboarding; settlement will retry`,
      );
    }
  }

  const done: Record<string, string> = {};
  let paid: { amount: number; currency: string } | null = null;
  for (const step of plan.steps) {
    switch (step.op) {
      case "capture":
        state = await gw.capture(state.id, step.amount, step.key);
        done.capture = state.id;
        break;
      case "cancel":
        state = await gw.cancel(state.id, step.key);
        done.cancel = state.id;
        break;
      case "refund":
        done.refund = (
          await gw.refund({ holdId: state.id, amount: step.amount, idempotencyKey: step.key })
        ).id;
        break;
      case "transfer": {
        const t = await gw.transfer({
          amount: step.amount,
          currency: agreement.currency,
          destination: seller?.stripeAccountId ?? "",
          agreementId: agreement.id,
          sourceCharge: state.charge_id ?? "",
          idempotencyKey: step.key,
        });
        done.transfer = t.id;
        // The seller is paid in the charge's settlement currency, which may differ.
        paid = { amount: t.amount, currency: t.currency };
        break;
      }
    }
  }

  const settlement = {
    release: plan.release,
    fee: plan.fee,
    seller_payout: plan.sellerPayout,
    buyer_refund: plan.buyerRefund,
    ...(paid ? { seller_paid: paid } : {}),
    ...done,
  };
  return applyEvent(db, {
    agreementId: agreement.id,
    scope: {},
    event: {
      type: "SETTLE",
      settlementRef: done.transfer ?? done.refund ?? done.cancel ?? done.capture ?? state.id,
      force: p.force,
    },
    actor: p.actor,
    now: p.now,
    afterTransition: async (tx) => {
      await tx
        .update(schema.holds)
        .set({
          status: "settled",
          settlement,
          capturedAmount: state.amount_received,
          updatedAt: p.now,
        })
        .where(eq(schema.holds.id, hold.id));
      await appendLedgerEntry(tx, {
        agreementId: agreement.id,
        type: "hold.settled",
        payload: { payment_intent_id: hold.paymentIntentId, ...settlement },
        createdAt: p.now,
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------------------------

const OPEN_STATES = [
  "funded",
  "delivered",
  "verifying",
  "escalated",
  "decided",
  "disputed",
] as const;

/**
 * Card authorizations lapse (~7 days, ~30 extended). A hold that would lapse before its agreement
 * settles is captured early into the platform balance, so a release can still be paid and a
 * refund becomes a refund instead of a lost authorization.
 */
export async function captureExpiringHolds(
  db: Db,
  gw: PaymentsGateway,
  now: Date,
  marginHours = 24,
) {
  const horizon = new Date(now.getTime() + marginHours * 3_600_000);
  const due = await db
    .select({ hold: schema.holds })
    .from(schema.holds)
    .innerJoin(schema.agreements, eq(schema.agreements.id, schema.holds.agreementId))
    .where(
      and(
        eq(schema.holds.status, "authorized"),
        lt(schema.holds.captureBefore, horizon),
        inArray(schema.agreements.status, [...OPEN_STATES]),
      ),
    );
  const captured: string[] = [];
  for (const { hold } of due) {
    const state = await gw.getHold(hold.paymentIntentId);
    if (state.status !== "requires_capture") {
      await syncHold(db, gw, hold.paymentIntentId, now);
      continue;
    }
    await gw.capture(state.id, state.amount_capturable, `early:${hold.agreementId}`);
    await syncHold(db, gw, hold.paymentIntentId, now);
    captured.push(hold.agreementId);
  }
  return captured;
}

export interface DueResult {
  captured_early: string[];
  deadlines_missed: string[];
  settled: string[];
  /** Agreements whose on-chain job the buyer reclaimed after expiry. */
  onchain_expired: string[];
  errors: { agreement_id: string; code: string; message: string }[];
}

/** One scheduler tick: run by cron (`npm run cli -- run-due`) or `POST /v1/ops/run-due`. */
export async function runDue(db: Db, rails: Rails, now: Date): Promise<DueResult> {
  const gw = rails.payments;
  const result: DueResult = {
    captured_early: [],
    deadlines_missed: [],
    settled: [],
    onchain_expired: [],
    errors: [],
  };
  const fail = (id: string, err: unknown) => {
    result.errors.push({
      agreement_id: id,
      code: err instanceof ApiError || err instanceof TransitionError ? err.code : "error",
      message: err instanceof Error ? err.message : String(err),
    });
  };

  if (gw) result.captured_early = await captureExpiringHolds(db, gw, now);
  // On-chain jobs can't be captured early; instead, settle before expiry (below) and flag
  // undecided ones for ops. Jobs the buyer already reclaimed are recorded.
  const expiringJobs = rails.chain ? await expiringOnchainJobs(db, now) : [];
  const settleNow = new Set(
    expiringJobs.filter((j) => j.status === "decided").map((j) => j.job.agreementId),
  );
  for (const j of expiringJobs) {
    if (j.status === "decided") continue;
    result.errors.push({
      agreement_id: j.job.agreementId,
      code: "onchain_expiry_near",
      message: `the on-chain job expires at ${j.job.expiresAt.toISOString()} and the agreement is still ${j.status}; decide it before then or the buyer can reclaim the funds`,
    });
  }
  if (rails.chain) result.onchain_expired = await syncOnchainJobs(db, rails.chain, now);

  const overdue = await db
    .select({ id: schema.agreements.id })
    .from(schema.agreements)
    .where(and(eq(schema.agreements.status, "funded"), lt(schema.agreements.deliveryDueAt, now)));
  for (const { id } of overdue) {
    try {
      await applyEvent(db, {
        agreementId: id,
        scope: {},
        event: { type: "MISS_DEADLINE" },
        actor: SYSTEM,
        now,
      });
      result.deadlines_missed.push(id);
    } catch (err) {
      fail(id, err);
    }
  }

  const decided = await db
    .select()
    .from(schema.agreements)
    .where(eq(schema.agreements.status, "decided"));
  for (const a of decided) {
    const force = settleNow.has(a.id);
    try {
      transition(snapshotOf(a), { type: "SETTLE", settlementRef: "pending", force }, SYSTEM, now);
    } catch {
      continue; // appeal window still open
    }
    try {
      await settleAgreement(db, rails, {
        agreementId: a.id,
        actor: SYSTEM,
        force,
        settlementRef: a.holdRail === "test" || !a.holdRail ? `auto:${a.id}` : undefined,
        now,
      });
      result.settled.push(a.id);
    } catch (err) {
      fail(a.id, err);
    }
  }
  return result;
}
