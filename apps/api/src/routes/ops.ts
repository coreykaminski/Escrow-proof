import { verifyLedger } from "@proofdesk/db";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { agreementJson, verificationJson } from "../serialize.ts";
import { applyEvent, getAgreement } from "../services/agreements.ts";
import { listVerifications, verifyAgreement } from "../services/verification.ts";
import { DecideBody, ResolveDisputeBody, SettleBody } from "./schemas.ts";

/**
 * Internal Proof Desk operations (keys with the "ops" scope). These act on any account's
 * agreements: run the automated verifier, make human decisions on escalations and disputes,
 * and settle (by hand until the payment rails in Part 4).
 */
export function opsRoutes({ db, now, verifier }: AppDeps) {
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
    const result = await verifyAgreement(db, verifier, { agreementId: c.req.param("id"), now });
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

  r.post("/agreements/:id/settle", async (c) => {
    const body = SettleBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: all,
      event: { type: "SETTLE", settlementRef: body.settlement_ref, force: body.force },
      actor: opsActor(c.get("auth").apiKeyId),
      now: now(),
    });
    return c.json(agreementJson(row));
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

  return r;
}
