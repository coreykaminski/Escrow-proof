import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, verifiersOf } from "../env.ts";
import { ApiError } from "../errors.ts";
import { agreementJson, verificationJson } from "../serialize.ts";
import { applyEvent, getAgreement } from "../services/agreements.ts";
import { settleAgreement } from "../services/payments.ts";
import { listVerifications, verifyAgreement } from "../services/verification.ts";
import { OutcomeBody } from "./schemas.ts";

export const SimulateDecisionBody = z.object({
  outcome: OutcomeBody,
  reason: z.string().min(1).max(500).default("sandbox decision"),
});

/**
 * Sandbox shortcuts for test-mode keys, so a developer can run the whole lifecycle without
 * Proof Desk ops: simulate the verifier's decision, run the real verifier, settle immediately.
 * Test-mode agreements only; live keys get 403.
 */
export function testHelperRoutes(deps: AppDeps) {
  const { db, now, payments, chain } = deps;
  const r = new Hono<AppEnv>();
  const system = { role: "system" as const, ref: "sandbox" };

  r.use("*", async (c, next) => {
    if (c.get("auth").mode !== "test") {
      throw new ApiError(403, "test_helpers_live", "test helpers only work with test-mode keys");
    }
    await next();
  });

  const ownTestAgreement = async (accountId: string, id: string) => {
    const row = await getAgreement(db, id, { accountId });
    if (row.livemode) throw new ApiError(403, "test_helpers_live", "not a test-mode agreement");
    return row;
  };

  /** Acts as the verifier: delivered/verifying → decided (auto) with the outcome you choose. */
  r.post("/agreements/:id/decide", async (c) => {
    const body = SimulateDecisionBody.parse(await c.req.json());
    let row = await ownTestAgreement(c.get("auth").accountId, c.req.param("id"));
    if (row.status === "delivered") {
      row = await applyEvent(db, {
        agreementId: row.id,
        scope: {},
        event: { type: "START_VERIFICATION" },
        actor: system,
        now: now(),
      });
    }
    row = await applyEvent(db, {
      agreementId: row.id,
      scope: {},
      event: {
        type: "DECIDE",
        outcome: body.outcome,
        decidedBy: "auto",
        confidence: 1,
        reason: body.reason,
      },
      actor: system,
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  /** Runs the real verifier (needs an Anthropic key on the server). */
  r.post("/agreements/:id/verify", async (c) => {
    const row = await ownTestAgreement(c.get("auth").accountId, c.req.param("id"));
    const result = await verifyAgreement(db, verifiersOf(deps), { agreementId: row.id, now });
    const [latest] = await listVerifications(db, row.id);
    return c.json({
      agreement: agreementJson(result.agreement),
      verification: latest ? verificationJson(latest) : null,
    });
  });

  /** Settles now, skipping the appeal window. */
  r.post("/agreements/:id/settle", async (c) => {
    const row = await ownTestAgreement(c.get("auth").accountId, c.req.param("id"));
    const settled = await settleAgreement(
      db,
      { payments, chain },
      {
        agreementId: row.id,
        actor: system,
        force: true,
        settlementRef: `sandbox:${row.id}`,
        now: now(),
      },
    );
    return c.json(agreementJson(settled));
  });

  return r;
}
