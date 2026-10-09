/**
 * The Verify API (MASTER_PLAN §3, "Verify API only"): check a deliverable against acceptance
 * criteria with no money held. A verification job is an ordinary agreement on the "none" rail,
 * created, approved, "funded" and delivered in one call, so it gets everything an agreement
 * has: the ledger, per-check billing, escalation to a human, shadow review and disputes.
 * Settling it moves no money; it just closes the job once the appeal window (default 0) ends.
 */
import { type Spec, SpecSchema } from "@proofdesk/core";
import { type Db, schema } from "@proofdesk/db";
import { and, desc, eq } from "drizzle-orm";
import { ApiError, toApiError } from "../errors.ts";
import {
  type AgreementRow,
  type ArtifactInput,
  applyEvent,
  createAgreement,
  getAgreement,
  type Scope,
  submitDelivery,
} from "./agreements.ts";
import { replaceInputs } from "./inputs.ts";
import { type Verifiers, verifyAgreement } from "./verification.ts";

export const VERIFY_ONLY_RAIL = "none";
const DAY_MS = 86_400_000;

/**
 * The caller's spec, with what a verification-only job doesn't need filled in: no amount
 * (zero, nothing is held), no appeal window unless asked, and a deadline a day out (the
 * delivery arrives in the same call).
 */
export function verifyOnlySpec(raw: Record<string, unknown>, now: Date): Spec {
  return SpecSchema.parse({
    amount: { value: 0, currency: "usd" },
    appeal_window_hours: 0,
    ...raw,
    delivery_due_at: new Date(now.getTime() + DAY_MS).toISOString(),
  });
}

export const isVerifyOnly = (row: Pick<AgreementRow, "holdRail">) =>
  row.holdRail === VERIFY_ONLY_RAIL;

/** Creates the job and runs the verifier. A verifier outage leaves it waiting for a retry. */
export async function createVerification(
  db: Db,
  verifiers: Verifiers,
  p: {
    accountId: string;
    livemode: boolean;
    spec: Spec;
    inputs: ArtifactInput[];
    deliverable: ArtifactInput[];
    buyerRef: string;
    sellerRef: string;
    metadata: Record<string, string>;
    now: () => Date;
  },
): Promise<AgreementRow> {
  const scope: Scope = { accountId: p.accountId };
  let row = await createAgreement(db, {
    accountId: p.accountId,
    livemode: p.livemode,
    buyerRef: p.buyerRef,
    sellerRef: p.sellerRef,
    spec: p.spec,
    metadata: p.metadata,
    now: p.now(),
  });
  if (p.inputs.length > 0) row = await replaceInputs(db, row.id, scope, p.inputs, p.now());
  await applyEvent(db, {
    agreementId: row.id,
    scope,
    event: { type: "APPROVE_SPEC", specHash: row.specHash },
    actor: { role: "buyer" },
    now: p.now(),
  });
  await applyEvent(db, {
    agreementId: row.id,
    scope,
    event: { type: "FUND", rail: VERIFY_ONLY_RAIL, holdRef: "verify-only" },
    actor: { role: "system", ref: "verify-api" },
    now: p.now(),
  });
  await submitDelivery(db, {
    agreementId: row.id,
    scope,
    actor: { role: "seller" },
    artifacts: p.deliverable,
    now: p.now(),
  });
  return runVerification(db, verifiers, row.id, p.now);
}

/** Runs (or re-runs, after an outage) the verifier on a verification job. */
export async function runVerification(
  db: Db,
  verifiers: Verifiers,
  id: string,
  now: () => Date,
): Promise<AgreementRow> {
  try {
    return (await verifyAgreement(db, verifiers, { agreementId: id, now })).agreement;
  } catch (err) {
    const api = toApiError(err);
    if (api.status >= 500 && api.code === "internal_error") throw err;
    // The job exists; tell the caller which one to retry or inspect.
    throw new ApiError(api.status, api.code, api.message, {
      ...(typeof api.details === "object" && api.details !== null ? api.details : {}),
      verification_job_id: id,
    });
  }
}

export async function getVerificationJob(db: Db, id: string, scope: Scope) {
  const row = await getAgreement(db, id, scope);
  if (!isVerifyOnly(row)) throw new ApiError(404, "not_found", "verification job not found");
  return row;
}

export async function listVerificationJobs(db: Db, accountId: string, limit: number) {
  return db
    .select()
    .from(schema.agreements)
    .where(
      and(
        eq(schema.agreements.accountId, accountId),
        eq(schema.agreements.holdRail, VERIFY_ONLY_RAIL),
      ),
    )
    .orderBy(desc(schema.agreements.createdAt), desc(schema.agreements.id))
    .limit(limit);
}
