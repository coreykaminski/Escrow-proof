import { listLedgerForAgreement } from "@proofdesk/db";
import { importMandate } from "@proofdesk/spec-engine";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../env.ts";
import { ApiError } from "../errors.ts";
import { agreementJson, deliveryJson, ledgerEntryJson } from "../serialize.ts";
import {
  applyEvent,
  createAgreement,
  getAgreement,
  listAgreements,
  listDeliveries,
  replaceSpec,
  submitDelivery,
} from "../services/agreements.ts";
import { draftAgreement, resolveMandateAmount } from "../services/spec-drafts.ts";
import {
  ApproveSpecBody,
  CancelBody,
  CreateAgreementBody,
  DeliveryBody,
  DisputeBody,
  FromMandateBody,
  FromRequestBody,
  FundBody,
  ListQuery,
  ReplaceSpecBody,
} from "./schemas.ts";

/**
 * Platform-facing routes. A platform key acts on behalf of the buyer and seller on its own
 * agreements; the actor role is fixed by the endpoint, or stated in the body where either
 * party could act.
 */
export function agreementRoutes({ db, now, drafter }: AppDeps) {
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
