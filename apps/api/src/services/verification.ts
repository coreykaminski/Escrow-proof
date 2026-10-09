import { hashValue, newId } from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema, type Tx } from "@proofdesk/db";
import {
  type AnyReport,
  type CodeInput,
  CodeInputError,
  type CodeReport,
  type DataInput,
  type DataReport,
  type TranslationInput,
  type VerificationReport,
} from "@proofdesk/verifier";
import { desc, eq } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import {
  type AgreementRow,
  applyEvent,
  getAgreement,
  listDeliveries,
  supportsPartial,
} from "./agreements.ts";
import { recordVerificationFee } from "./billing.ts";
import { listInputs } from "./inputs.ts";

/** Runs the translation verifier; injected so tests can use a stubbed model caller. */
export type TranslationVerifier = (input: TranslationInput) => Promise<VerificationReport>;
/** Runs the buyer's tests against delivered code in a sandbox (+ the model judge if configured). */
export type CodeVerifier = (input: CodeInput) => Promise<CodeReport>;
/** Validates delivered data / checks a research report's citations (+ the model judge). */
export type DataVerifier = (input: DataInput) => Promise<DataReport>;

export interface Verifiers {
  translation?: TranslationVerifier | undefined;
  code?: CodeVerifier | undefined;
  data?: DataVerifier | undefined;
}

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
  verifiers: Verifiers,
  params: { agreementId: string; now: () => Date },
): Promise<{ agreement: AgreementRow; verificationId: string; report: AnyReport }> {
  const all = {};
  let agreement = await getAgreement(db, params.agreementId, all);
  const vertical = agreement.spec.vertical;
  if (vertical === "general") {
    throw new ApiError(
      422,
      "no_automated_verifier",
      `there's no automated verifier for "${vertical}" jobs; decide by hand`,
    );
  }
  if (!verifiers[vertical]) {
    throw new ApiError(
      503,
      "verifier_unavailable",
      `the ${vertical} verifier isn't configured on this server`,
    );
  }
  if (agreement.status !== "delivered" && agreement.status !== "verifying") {
    throw new ApiError(
      409,
      "invalid_transition",
      `can't verify an agreement in status "${agreement.status}"`,
    );
  }

  const inputs = await listInputs(db, agreement.id);
  const [delivery] = await listDeliveries(db, agreement.id);
  if (!delivery) throw new ApiError(409, "no_delivery", "nothing has been delivered");
  const run = await prepareRun(agreement, inputs, delivery.artifacts, verifiers);

  if (agreement.status === "delivered") {
    agreement = await applyEvent(db, {
      agreementId: agreement.id,
      scope: all,
      event: { type: "START_VERIFICATION" },
      actor: { role: "system", ref: "verifier" },
      now: params.now(),
    });
  }

  let report: AnyReport;
  try {
    report = await run();
  } catch (err) {
    if (err instanceof CodeInputError) throw new ApiError(422, "missing_tests", err.message);
    throw err;
  }
  // Round-trip through JSON so the stored and hashed report are exactly the same value.
  const stored = JSON.parse(JSON.stringify(report)) as AnyReport;
  const reportHash = hashValue(stored);
  const at = params.now();
  const verificationId = newId("verification", at.getTime());
  const actor = { role: "system" as const, ref: `verifier:${report.engine_version}` };
  const { decision } = stored;
  // A standard ERC-8183 job can't settle a partial outcome: a human picks release or refund.
  const partialBlocked =
    decision.action === "decide" &&
    decision.outcome.kind === "partial" &&
    !supportsPartial(agreement);

  const recordVerification = async (tx: Tx) => {
    await tx.insert(schema.verifications).values({
      id: verificationId,
      agreementId: agreement.id,
      deliveryId: delivery.id,
      engineVersion: stored.engine_version,
      report: stored,
      reportHash,
      action: partialBlocked ? "escalate" : decision.action,
      outcome: decision.action === "decide" && !partialBlocked ? decision.outcome : null,
      confidence: decision.confidence,
      costUsd: stored.usage.cost_usd,
      createdAt: at,
    });
    await recordVerificationFee(tx, { agreement, verificationId, report: stored, now: at });
    await appendLedgerEntry(tx, {
      agreementId: agreement.id,
      type: "agreement.verification_recorded",
      payload: {
        verification_id: verificationId,
        delivery_id: delivery.id,
        engine_version: stored.engine_version,
        report_hash: reportHash,
        action: partialBlocked ? "escalate" : decision.action,
      },
      createdAt: at,
    });
  };

  const [account] = await db
    .select({ shadowMode: schema.accounts.shadowMode })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, agreement.accountId));
  const updated = await applyEvent(db, {
    agreementId: agreement.id,
    scope: all,
    actor,
    now: at,
    event:
      decision.action === "decide" && !partialBlocked
        ? {
            type: "DECIDE",
            outcome: decision.outcome,
            decidedBy: "auto",
            confidence: decision.confidence,
            reason: decision.reason,
            review: account?.shadowMode === true,
          }
        : {
            type: "ESCALATE",
            reason: partialBlocked
              ? `The verifier proposed a partial release (${decision.outcome.kind === "partial" ? decision.outcome.releasePercent : 0}% to the seller), which this ERC-8183 job can't settle; a reviewer must choose release or refund. ${decision.reason}`
              : decision.reason,
          },
    afterTransition: (tx) => recordVerification(tx),
  });
  return { agreement: updated, verificationId, report: stored };
}

type Input = Awaited<ReturnType<typeof listInputs>>[number];
type Artifact = { name: string; mediaType: string; content: string };

/** Checks the agreement has what its vertical's verifier needs; returns the call to make. */
async function prepareRun(
  agreement: AgreementRow,
  inputs: Input[],
  artifacts: Artifact[],
  verifiers: Verifiers,
): Promise<() => Promise<AnyReport>> {
  const spec = agreement.spec;
  switch (spec.vertical) {
    case "translation": {
      const source = inputs.filter((i) => isText(i.mediaType));
      if (source.length === 0) {
        throw new ApiError(
          422,
          "missing_source",
          "a translation agreement needs its source document attached as a text input",
        );
      }
      const target = artifacts.filter((a) => isText(a.mediaType));
      if (target.length === 0) {
        throw new ApiError(422, "unsupported_deliverable", "the delivery has no text artifacts");
      }
      const verify = verifiers.translation as TranslationVerifier;
      return () =>
        verify({
          spec,
          source: source.map((i) => i.content).join("\n\n"),
          target: target.map((a) => a.content).join("\n\n"),
        });
    }
    case "code": {
      const verify = verifiers.code as CodeVerifier;
      return () =>
        verify({
          spec,
          inputs: inputs.map((i) => ({ name: i.name, content: i.content })),
          deliverable: artifacts.map((a) => ({ name: a.name, content: a.content })),
        });
    }
    case "data": {
      const verify = verifiers.data as DataVerifier;
      return () =>
        verify({
          spec,
          inputs: inputs.map((i) => ({
            name: i.name,
            media_type: i.mediaType,
            content: i.content,
          })),
          deliverable: artifacts.map((a) => ({
            name: a.name,
            media_type: a.mediaType,
            content: a.content,
          })),
        });
    }
    default:
      throw new ApiError(422, "no_automated_verifier", "no automated verifier for this job");
  }
}

export async function listVerifications(db: Db, agreementId: string) {
  return db
    .select()
    .from(schema.verifications)
    .where(eq(schema.verifications.agreementId, agreementId))
    .orderBy(desc(schema.verifications.createdAt));
}
