import { hashValue, newId } from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema, type Tx } from "@proofdesk/db";
import type { TranslationInput, VerificationReport } from "@proofdesk/verifier";
import { desc, eq } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import { type AgreementRow, applyEvent, getAgreement, listDeliveries } from "./agreements.ts";
import { listInputs } from "./inputs.ts";

/** Runs the translation verifier; injected so tests can use a stubbed model caller. */
export type TranslationVerifier = (input: TranslationInput) => Promise<VerificationReport>;

const isText = (mediaType: string) => /^text\//i.test(mediaType);

/**
 * Verify the latest delivery and act on the result:
 * 1. delivered → verifying (committed, so a crash mid-review leaves a visible state);
 * 2. run the verifier outside any transaction (model calls take seconds);
 * 3. in one transaction: store the report, ledger it, then DECIDE (auto) or ESCALATE.
 * Re-running from "verifying" is allowed, e.g. after the model was unavailable.
 */
export async function verifyAgreement(
  db: Db,
  verifier: TranslationVerifier | undefined,
  params: { agreementId: string; now: () => Date },
): Promise<{ agreement: AgreementRow; verificationId: string; report: VerificationReport }> {
  const all = {};
  let agreement = await getAgreement(db, params.agreementId, all);
  if (agreement.spec.vertical !== "translation") {
    throw new ApiError(
      422,
      "no_automated_verifier",
      `there's no automated verifier for "${agreement.spec.vertical}" jobs yet; decide by hand`,
    );
  }
  if (!verifier) {
    throw new ApiError(503, "verifier_unavailable", "the verifier isn't configured on this server");
  }
  if (agreement.status !== "delivered" && agreement.status !== "verifying") {
    throw new ApiError(
      409,
      "invalid_transition",
      `can't verify an agreement in status "${agreement.status}"`,
    );
  }

  const inputs = (await listInputs(db, agreement.id)).filter((i) => isText(i.mediaType));
  if (inputs.length === 0) {
    throw new ApiError(
      422,
      "missing_source",
      "a translation agreement needs its source document attached as a text input",
    );
  }
  const [delivery] = await listDeliveries(db, agreement.id);
  if (!delivery) throw new ApiError(409, "no_delivery", "nothing has been delivered");
  const target = delivery.artifacts.filter((a) => isText(a.mediaType));
  if (target.length === 0) {
    throw new ApiError(422, "unsupported_deliverable", "the delivery has no text artifacts");
  }

  if (agreement.status === "delivered") {
    agreement = await applyEvent(db, {
      agreementId: agreement.id,
      scope: all,
      event: { type: "START_VERIFICATION" },
      actor: { role: "system", ref: "verifier" },
      now: params.now(),
    });
  }

  const report = await verifier({
    spec: agreement.spec,
    source: inputs.map((i) => i.content).join("\n\n"),
    target: target.map((a) => a.content).join("\n\n"),
  });
  // Round-trip through JSON so the stored and hashed report are exactly the same value.
  const stored = JSON.parse(JSON.stringify(report)) as VerificationReport;
  const reportHash = hashValue(stored);
  const at = params.now();
  const verificationId = newId("verification", at.getTime());
  const actor = { role: "system" as const, ref: `verifier:${report.engine_version}` };
  const { decision } = stored;

  const recordVerification = async (tx: Tx) => {
    await tx.insert(schema.verifications).values({
      id: verificationId,
      agreementId: agreement.id,
      deliveryId: delivery.id,
      engineVersion: stored.engine_version,
      report: stored,
      reportHash,
      action: decision.action,
      outcome: decision.action === "decide" ? decision.outcome : null,
      confidence: decision.confidence,
      costUsd: stored.usage.cost_usd,
      createdAt: at,
    });
    await appendLedgerEntry(tx, {
      agreementId: agreement.id,
      type: "agreement.verification_recorded",
      payload: {
        verification_id: verificationId,
        delivery_id: delivery.id,
        engine_version: stored.engine_version,
        report_hash: reportHash,
        action: decision.action,
      },
      createdAt: at,
    });
  };

  const updated = await applyEvent(db, {
    agreementId: agreement.id,
    scope: all,
    actor,
    now: at,
    event:
      decision.action === "decide"
        ? {
            type: "DECIDE",
            outcome: decision.outcome,
            decidedBy: "auto",
            confidence: decision.confidence,
            reason: decision.reason,
          }
        : { type: "ESCALATE", reason: decision.reason },
    afterTransition: (tx) => recordVerification(tx),
  });
  return { agreement: updated, verificationId, report: stored };
}

export async function listVerifications(db: Db, agreementId: string) {
  return db
    .select()
    .from(schema.verifications)
    .where(eq(schema.verifications.agreementId, agreementId))
    .orderBy(desc(schema.verifications.createdAt));
}
