import { verifyLedger } from "@proofdesk/db";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, verifiersOf } from "../env.ts";
import { ApiError } from "../errors.ts";
import { agreementJson, verificationJson } from "../serialize.ts";
import { applyEvent, getAgreement } from "../services/agreements.ts";
import { anchorLedger, verifyAnchors } from "../services/anchoring.ts";
import { verificationStats } from "../services/metrics.ts";
import { settleAgreement } from "../services/payments.ts";
import { tick } from "../services/scheduler.ts";
import { getState } from "../services/status.ts";
import { listVerifications, verifyAgreement } from "../services/verification.ts";
import { DecideBody, ResolveDisputeBody, SettleBody } from "./schemas.ts";

/**
 * Internal Proof Desk operations (keys with the "ops" scope). These act on any account's
 * agreements: run the automated verifier, make human decisions on escalations and disputes,
 * and settle (by hand until the payment rails in Part 4).
 */
export function opsRoutes(deps: AppDeps) {
  const { db, now, payments, chain, fetch } = deps;
  const r = new Hono<AppEnv>();
  const all = {};
  const opsActor = (apiKeyId: string) => ({ role: "ops" as const, ref: apiKeyId });

  r.get("/agreements/:id", async (c) => {
    return c.json(agreementJson(await getAgreement(db, c.req.param("id"), all)));
  });

  r.post("/agreements/:id/start-verification", async (c) => {
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: all,
      event: { type: "START_VERIFICATION" },
      actor: opsActor(c.get("auth").apiKeyId),
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  /** Runs the automated verifier on the latest delivery, then decides or escalates. */
  r.post("/agreements/:id/verify", async (c) => {
    const result = await verifyAgreement(db, verifiersOf(deps), {
      agreementId: c.req.param("id"),
      now,
    });
    const [latest] = await listVerifications(db, result.agreement.id);
    return c.json({
      agreement: agreementJson(result.agreement),
      verification: latest ? verificationJson(latest) : null,
    });
  });

  r.post("/agreements/:id/decide", async (c) => {
    const body = DecideBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: all,
      event: {
        type: "DECIDE",
        outcome: body.outcome,
        decidedBy: "human",
        confidence: body.confidence,
        reason: body.reason,
      },
      actor: opsActor(c.get("auth").apiKeyId),
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  r.post("/agreements/:id/miss-deadline", async (c) => {
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: all,
      event: { type: "MISS_DEADLINE" },
      actor: opsActor(c.get("auth").apiKeyId),
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  r.post("/agreements/:id/resolve-dispute", async (c) => {
    const body = ResolveDisputeBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: all,
      event: { type: "RESOLVE_DISPUTE", outcome: body.outcome, reason: body.reason },
      actor: opsActor(c.get("auth").apiKeyId),
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  /** Moves the money for a final decision (card: capture/cancel/refund + transfer), then settles. */
  r.post("/agreements/:id/settle", async (c) => {
    const body = SettleBody.parse(await c.req.json());
    const row = await settleAgreement(
      db,
      { payments, chain },
      {
        agreementId: c.req.param("id"),
        actor: opsActor(c.get("auth").apiKeyId),
        force: body.force,
        ...(body.settlement_ref ? { settlementRef: body.settlement_ref } : {}),
        now: now(),
      },
    );
    return c.json(agreementJson(row));
  });

  /**
   * Scheduler tick: capture holds about to lapse, refund missed deadlines, settle due agreements,
   * deliver webhooks.
   */
  r.post("/run-due", async (c) => {
    return c.json(await tick(db, { payments, chain, ...(fetch ? { fetch } : {}) }, now()));
  });

  /**
   * Operational metrics: this instance's request stats since start, verification volume,
   * escalations, latency and model cost over the last 24 h, and the scheduler heartbeat.
   */
  r.get("/metrics", async (c) => {
    const at = now();
    const [verifications, scheduler] = await Promise.all([
      verificationStats(db, new Date(at.getTime() - 86_400_000)),
      getState(db, "scheduler.tick"),
    ]);
    return c.json({
      object: "metrics",
      at: at.toISOString(),
      requests: deps.metrics?.snapshot() ?? null,
      verifications,
      scheduler: scheduler
        ? { last_tick_at: scheduler.updatedAt.toISOString(), last: scheduler.value }
        : null,
    });
  });

  r.get("/ledger/verify", async (c) => {
    const result = await verifyLedger(db);
    return c.json(
      result.ok
        ? { ok: true, count: result.count, head_seq: result.headSeq, head_hash: result.headHash }
        : { ok: false, seq: result.seq, reason: result.reason },
      result.ok ? 200 : 500,
    );
  });

  /** Post the ledger head on-chain now (the worker also does it daily). */
  r.post("/ledger/anchor", async (c) => {
    if (!deps.anchor)
      throw new ApiError(503, "anchoring_unavailable", "ANCHOR_CONTRACT isn't configured");
    return c.json(await anchorLedger(db, deps.anchor, now()));
  });

  /** Check every on-chain anchor against the database. */
  r.get("/ledger/anchors", async (c) => {
    if (!deps.anchor)
      throw new ApiError(503, "anchoring_unavailable", "ANCHOR_CONTRACT isn't configured");
    return c.json(await verifyAnchors(db, deps.anchor));
  });

  return r;
}
