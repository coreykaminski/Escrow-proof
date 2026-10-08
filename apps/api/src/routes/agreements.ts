import { listLedgerForAgreement } from "@proofdesk/db";
import { importMandate } from "@proofdesk/spec-engine";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";
import {
  agreementJson,
  deliveryJson,
  holdJson,
  inputJson,
  ledgerEntryJson,
  verificationJson,
} from "../serialize.ts";
import {
  applyEvent,
  createAgreement,
  getAgreement,
  listAgreements,
  listDeliveries,
  replaceSpec,
  submitDelivery,
} from "../services/agreements.ts";
import { listInputs, replaceInputs } from "../services/inputs.ts";
import { createCardHold, getHold } from "../services/payments.ts";
import { createShareLink } from "../services/share-links.ts";
import { draftAgreement, resolveMandateAmount } from "../services/spec-drafts.ts";
import { listVerifications } from "../services/verification.ts";
import {
  ApproveSpecBody,
  CancelBody,
  CardHoldBody,
  CreateAgreementBody,
  DeliveryBody,
  DisputeBody,
  FromMandateBody,
  FromRequestBody,
  FundBody,
  InputsBody,
  LinkBody,
  ListQuery,
  ReplaceSpecBody,
} from "./schemas.ts";

/**
 * Platform-facing routes. A platform key acts on behalf of the buyer and seller on its own
 * agreements; the actor role is fixed by the endpoint, or stated in the body where either
 * party could act.
 */
export function agreementRoutes(deps: AppDeps) {
  const { db, now, drafter, payments } = deps;
  const r = new Hono<AppEnv>();

  r.post("/", async (c) => {
    const body = CreateAgreementBody.parse(await c.req.json());
    const auth = c.get("auth");
    const row = await createAgreement(db, {
      accountId: auth.accountId,
      livemode: auth.mode === "live",
      buyerRef: body.buyer_ref,
      sellerRef: body.seller_ref,
      spec: body.spec,
      metadata: body.metadata,
      now: now(),
    });
    return c.json(agreementJson(row), 201);
  });

  /** Drafts the spec from a plain-language request; the agreement starts in draft for review. */
  r.post("/from-request", async (c) => {
    const body = FromRequestBody.parse(await c.req.json());
    const auth = c.get("auth");
    const row = await draftAgreement(db, drafter, {
      accountId: auth.accountId,
      livemode: auth.mode === "live",
      buyerRef: body.buyer_ref,
      sellerRef: body.seller_ref,
      terms: {
        request: body.request,
        title: body.title,
        vertical: body.vertical,
        amount: body.amount,
        delivery_due_at: body.delivery_due_at,
        appeal_window_hours: body.appeal_window_hours,
      },
      metadata: body.metadata,
      now: now(),
    });
    return c.json(agreementJson(row), 201);
  });

  /** Same, with "what was asked" (and, for a cart, the price) taken from an AP2 mandate. */
  r.post("/from-mandate", async (c) => {
    const body = FromMandateBody.parse(await c.req.json());
    const auth = c.get("auth");
    const at = now();
    const mandate = importMandate(body.mandate_type, body.mandate, at);
    const row = await draftAgreement(db, drafter, {
      accountId: auth.accountId,
      livemode: auth.mode === "live",
      buyerRef: body.buyer_ref,
      sellerRef: body.seller_ref,
      terms: {
        request: mandate.request,
        title: body.title,
        vertical: body.vertical,
        amount: resolveMandateAmount(mandate, body.amount),
        delivery_due_at: body.delivery_due_at,
        appeal_window_hours: body.appeal_window_hours,
      },
      metadata: body.metadata,
      mandate,
      now: at,
    });
    return c.json(agreementJson(row), 201);
  });

  r.get("/", async (c) => {
    const q = ListQuery.parse(c.req.query());
    const rows = await listAgreements(db, c.get("auth").accountId, q);
    return c.json({ object: "list", data: rows.map(agreementJson) });
  });

  r.get("/:id", async (c) => {
    const row = await getAgreement(db, c.req.param("id"), { accountId: c.get("auth").accountId });
    return c.json(agreementJson(row));
  });

  r.put("/:id/spec", async (c) => {
    const { spec } = ReplaceSpecBody.parse(await c.req.json());
    const scope = { accountId: c.get("auth").accountId };
    const row = await replaceSpec(db, c.req.param("id"), scope, spec, now());
    return c.json(agreementJson(row));
  });

  /** Source material (e.g. the document to translate); draft only, locked by the spec hash. */
  r.put("/:id/inputs", async (c) => {
    const { inputs } = InputsBody.parse(await c.req.json());
    const scope = { accountId: c.get("auth").accountId };
    const row = await replaceInputs(db, c.req.param("id"), scope, inputs, now());
    return c.json(agreementJson(row));
  });

  r.get("/:id/inputs", async (c) => {
    const id = c.req.param("id");
    await getAgreement(db, id, { accountId: c.get("auth").accountId });
    const includeContent = c.req.query("include_content") === "true";
    const rows = await listInputs(db, id);
    return c.json({ object: "list", data: rows.map((r) => inputJson(r, includeContent)) });
  });

  r.get("/:id/verifications", async (c) => {
    const id = c.req.param("id");
    await getAgreement(db, id, { accountId: c.get("auth").accountId });
    const rows = await listVerifications(db, id);
    return c.json({ object: "list", data: rows.map(verificationJson) });
  });

  r.post("/:id/approve-spec", async (c) => {
    const body = ApproveSpecBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      event: { type: "APPROVE_SPEC", specHash: body.spec_hash },
      actor: { role: "buyer" },
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  r.post("/:id/cancel", async (c) => {
    const body = CancelBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      event: { type: "CANCEL", reason: body.reason },
      actor: { role: body.actor },
      now: now(),
    });
    return c.json(agreementJson(row));
  });

  r.post("/:id/fund", async (c) => {
    const body = FundBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      event: { type: "FUND", rail: body.rail, holdRef: body.hold_ref },
      actor: { role: "buyer" },
      now: now(),
      beforeTransition: (current) => {
        if (current.livemode && body.rail === "test") {
          throw new ApiError(
            400,
            "test_rail_in_livemode",
            "the test rail can't fund a live agreement",
          );
        }
      },
    });
    return c.json(agreementJson(row));
  });

  /**
   * Funds the agreement with a card authorization hold. Returns the client_secret for the buyer
   * to confirm on the client; with payment_method it's confirmed immediately. The agreement
   * becomes "funded" once the card is authorized (here or via the Stripe webhook).
   */
  r.post("/:id/card-hold", async (c) => {
    if (!payments)
      throw new ApiError(503, "payments_unavailable", "card payments aren't configured");
    const body = CardHoldBody.parse(await c.req.json().catch(() => ({})));
    const { hold, state, agreement } = await createCardHold(db, payments, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      ...(body.payment_method ? { paymentMethod: body.payment_method } : {}),
      now: now(),
    });
    return c.json(
      {
        hold: holdJson(hold),
        payment_intent_status: state.status,
        client_secret: state.client_secret,
        agreement: agreementJson(agreement),
      },
      201,
    );
  });

  /** A public, read-only verdict report link to share with the buyer and seller. */
  r.post("/:id/report-links", async (c) => {
    const body = LinkBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const agreement = await getAgreement(db, c.req.param("id"), { accountId: auth.accountId });
    const { token, expiresAt } = await createShareLink(db, {
      kind: "report",
      agreementId: agreement.id,
      createdByKeyId: auth.apiKeyId,
      ttlDays: body.expires_in_days,
      now: now(),
    });
    const base = deps.publicUrl ?? new URL(c.req.url).origin;
    return c.json({ url: `${base}/r/${token}`, expires_at: expiresAt.toISOString() }, 201);
  });

  /**
   * A hosted page where the buyer enters their card (for agents and platforms that don't collect
   * cards themselves). Creates the card hold if needed.
   */
  r.post("/:id/payment-links", async (c) => {
    if (!payments)
      throw new ApiError(503, "payments_unavailable", "card payments aren't configured");
    const body = LinkBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const { agreement } = await createCardHold(db, payments, {
      agreementId: c.req.param("id"),
      scope: { accountId: auth.accountId },
      now: now(),
    });
    const { token, expiresAt } = await createShareLink(db, {
      kind: "pay",
      agreementId: agreement.id,
      createdByKeyId: auth.apiKeyId,
      ttlDays: body.expires_in_days,
      now: now(),
    });
    const base = deps.publicUrl ?? new URL(c.req.url).origin;
    return c.json({ url: `${base}/pay/${token}`, expires_at: expiresAt.toISOString() }, 201);
  });

  r.get("/:id/hold", async (c) => {
    const id = c.req.param("id");
    await getAgreement(db, id, { accountId: c.get("auth").accountId });
    const hold = await getHold(db, id);
    if (!hold) throw new ApiError(404, "not_found", "this agreement has no card hold");
    return c.json(holdJson(hold));
  });

  r.post("/:id/deliveries", async (c) => {
    const body = DeliveryBody.parse(await c.req.json());
    const result = await submitDelivery(db, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      actor: { role: "seller" },
      artifacts: body.artifacts,
      now: now(),
    });
    return c.json(
      {
        delivery_id: result.deliveryId,
        manifest_hash: result.manifestHash,
        agreement: agreementJson(result.agreement),
      },
      201,
    );
  });

  r.get("/:id/deliveries", async (c) => {
    const id = c.req.param("id");
    await getAgreement(db, id, { accountId: c.get("auth").accountId });
    const includeContent = c.req.query("include_content") === "true";
    const rows = await listDeliveries(db, id);
    return c.json({ object: "list", data: rows.map((d) => deliveryJson(d, includeContent)) });
  });

  r.post("/:id/disputes", async (c) => {
    const body = DisputeBody.parse(await c.req.json());
    const row = await applyEvent(db, {
      agreementId: c.req.param("id"),
      scope: { accountId: c.get("auth").accountId },
      event: { type: "OPEN_DISPUTE", reason: body.reason },
      actor: { role: body.opened_by },
      now: now(),
    });
    return c.json(agreementJson(row), 201);
  });

  r.get("/:id/ledger", async (c) => {
    const id = c.req.param("id");
    await getAgreement(db, id, { accountId: c.get("auth").accountId });
    const rows = await listLedgerForAgreement(db, id);
    return c.json({ object: "list", data: rows.map(ledgerEntryJson) });
  });

  return r;
}
