/**
 * Evaluator-for-hire (MASTER_PLAN Part 10): a buyer creates and funds a job on *any* standard
 * ERC-8183 contract, naming Proof Desk's address as the evaluator, and the platform attaches it
 * to an agreement. Proof Desk then verifies the delivery as usual and settles with the
 * standard `complete` (pay the provider) or `reject` (refund the client). Proof Desk never
 * holds the funds and can't move them anywhere but to the job's own provider or client.
 *
 * Trust comes from the chain, not the request: the job must name our evaluator, hold exactly
 * the agreed amount of the agreed token, carry the agreement's id and spec hash in its
 * description (so the buyer's own transaction commits to the approved spec), and stay open long
 * enough to verify and hear an appeal before the buyer can reclaim it.
 */
import { ChainError, type ChainGateway } from "@proofdesk/chain";
import { type Actor, newId, TransitionError } from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema } from "@proofdesk/db";
import { getAddress, type Hex, isAddress, zeroAddress } from "viem";
import { ApiError } from "../errors.ts";
import {
  type AgreementRow,
  applyEvent,
  EXTERNAL_HOLD_PREFIX,
  getAgreement,
  type Scope,
} from "./agreements.ts";
import {
  getOnchainJob,
  isUniqueViolation,
  ONCHAIN_CURRENCY,
  type OnchainJobRow,
  onchainExpiry,
} from "./onchain.ts";

const SYSTEM: Actor = { role: "system", ref: "erc8183" };
const HOUR_MS = 3_600_000;
/** Minimum time after the decision window for review and an appeal before the buyer can reclaim. */
const MIN_BUFFER_HOURS = 48;

/** The text a job's description must contain to be attached to this agreement. */
export function descriptionTag(a: Pick<AgreementRow, "id" | "specHash">): string {
  return `proofdesk:v1:${a.id}:${a.specHash}`;
}

/** The earliest acceptable on-chain expiry: deadline + a day to verify + appeal + buffer. */
export function minimumExpiry(a: Pick<AgreementRow, "deliveryDueAt" | "appealWindowHours">) {
  const ms = a.deliveryDueAt.getTime() + (24 + a.appealWindowHours + MIN_BUFFER_HOURS) * HOUR_MS;
  return new Date(Math.ceil(ms / 1000) * 1000);
}

async function checkAgreement(db: Db, chain: ChainGateway, agreementId: string, scope: Scope) {
  const agreement = await getAgreement(db, agreementId, scope);
  const cfg = await chain.config();
  if (agreement.livemode !== (cfg.mode === "live")) {
    throw new ApiError(
      400,
      "livemode_mismatch",
      `a ${agreement.livemode ? "live" : "test"} agreement can't use the ${cfg.mode} chain`,
    );
  }
  if (agreement.currency !== ONCHAIN_CURRENCY) {
    throw new ApiError(
      400,
      "unsupported_currency",
      `ERC-8183 jobs settle in ${ONCHAIN_CURRENCY.toUpperCase()}; this agreement is in ${agreement.currency.toUpperCase()}`,
    );
  }
  return { agreement, cfg };
}

/** What the buyer's job must look like for Proof Desk to accept the evaluator role. */
export async function externalJobTerms(
  db: Db,
  chain: ChainGateway,
  p: { agreementId: string; scope: Scope },
) {
  const { agreement, cfg } = await checkAgreement(db, chain, p.agreementId, p.scope);
  return {
    object: "external_job_terms",
    agreement_id: agreement.id,
    chain_id: cfg.chainId,
    evaluator: cfg.evaluator,
    token: cfg.token,
    budget: String(agreement.amountValue),
    description_must_contain: descriptionTag(agreement),
    min_expired_at: Math.floor(minimumExpiry(agreement).getTime() / 1000),
    recommended_expired_at: Math.floor(onchainExpiry(agreement).getTime() / 1000),
    hook: zeroAddress,
    outcomes: ["complete", "reject"],
    notes: [
      "Fund the job before attaching it; the provider must call submit() before it can be completed.",
      "Partial releases can't be expressed with complete/reject: a partial decision goes to a human, who chooses release or refund.",
    ],
  };
}

/**
 * Attaches a funded job on another ERC-8183 contract to the agreement and funds the agreement.
 * Re-attaching the same job is a no-op; any other job is refused once one is attached.
 */
export async function attachExternalJob(
  db: Db,
  chain: ChainGateway,
  p: { agreementId: string; scope: Scope; contract: string; jobId: string; now: Date },
): Promise<{ row: OnchainJobRow; agreement: AgreementRow }> {
  const { agreement, cfg } = await checkAgreement(db, chain, p.agreementId, p.scope);
  if (!isAddress(p.contract, { strict: false })) {
    throw new ApiError(400, "validation_error", "contract must be a 0x-prefixed EVM address");
  }
  if (!/^\d{1,78}$/.test(p.jobId)) {
    throw new ApiError(400, "validation_error", "job_id must be a decimal uint256");
  }
  const contract = getAddress(p.contract);
  const jobId = BigInt(p.jobId);

  const existing = await getOnchainJob(db, agreement.id);
  if (existing) {
    if (
      existing.kind === "external" &&
      existing.contract === contract &&
      existing.jobId === p.jobId
    ) {
      return { row: existing, agreement };
    }
    throw new ApiError(409, "already_funding", "this agreement already has an on-chain job");
  }
  if (agreement.status !== "spec_approved") {
    throw new ApiError(
      409,
      "invalid_transition",
      `can't fund an agreement in status "${agreement.status}"`,
    );
  }

  let job: Awaited<ReturnType<ChainGateway["getJobAt"]>>;
  try {
    job = await chain.getJobAt(contract, jobId);
  } catch (err) {
    if (err instanceof ChainError && !err.retryable) {
      throw new ApiError(
        422,
        "job_not_found",
        `no ERC-8183 job ${p.jobId} on ${contract} (${err.message})`,
      );
    }
    throw err;
  }
  const token = await chain.paymentTokenAt(contract);
  const tag = descriptionTag(agreement);
  const minExpiry = BigInt(Math.floor(minimumExpiry(agreement).getTime() / 1000));
  const problems = [
    getAddress(job.evaluator) !== cfg.evaluator && `the evaluator must be ${cfg.evaluator}`,
    job.status !== "funded" && job.status !== "submitted" && `the job is ${job.status}, not funded`,
    job.budget !== BigInt(agreement.amountValue) &&
      `the budget is ${job.budget}, the agreement is ${agreement.amountValue}`,
    token === null && "the contract doesn't expose paymentToken(), so the token can't be checked",
    token !== null && token !== cfg.token && `the contract pays in ${token}, not ${cfg.token}`,
    !job.description.includes(tag) && `the description must contain "${tag}"`,
    job.expiredAt < minExpiry && `the job must not expire before ${minExpiry} (unix seconds)`,
    getAddress(job.hook) !== zeroAddress && "jobs with a hook contract aren't supported",
    job.provider === zeroAddress && "the job has no provider",
  ].filter((x): x is string => typeof x === "string");
  if (problems.length > 0) {
    throw new ApiError(422, "terms_mismatch", `can't evaluate this job: ${problems.join("; ")}`);
  }

  const holdRef = `${EXTERNAL_HOLD_PREFIX}${cfg.chainId}:${contract}:${jobId}`;
  const values = {
    id: newId("onchainJob", p.now.getTime()),
    agreementId: agreement.id,
    chainId: cfg.chainId,
    contract,
    kind: "external" as const,
    jobId: p.jobId,
    client: getAddress(job.client),
    provider: getAddress(job.provider),
    evaluator: cfg.evaluator,
    description: job.description,
    budget: agreement.amountValue,
    expiresAt: new Date(Number(job.expiredAt) * 1000),
    status: "funded" as const,
    createdAt: p.now,
    updatedAt: p.now,
  };
  try {
    const updated = await applyEvent(db, {
      agreementId: agreement.id,
      scope: {},
      event: { type: "FUND", rail: "onchain", holdRef },
      actor: SYSTEM,
      now: p.now,
      afterTransition: async (tx) => {
        await tx.insert(schema.onchainJobs).values(values);
        await appendLedgerEntry(tx, {
          agreementId: agreement.id,
          type: "onchain_job.attached",
          payload: {
            standard: "erc8183",
            chain_id: cfg.chainId,
            contract,
            job_id: p.jobId,
            client: values.client,
            provider: values.provider,
            budget: values.budget,
            token,
            expired_at: Number(job.expiredAt),
            job_status: job.status,
          },
          createdAt: p.now,
        });
      },
    });
    return { row: (await getOnchainJob(db, agreement.id)) as OnchainJobRow, agreement: updated };
  } catch (err) {
    if (err instanceof TransitionError && err.code === "deadline_passed") {
      // The buyer's money is already locked: as its evaluator, give it straight back.
      const { txHash } = await chain.reject({
        contract,
        jobId,
        reason: `0x${"0".repeat(64)}` as Hex,
      });
      await db.transaction((tx) =>
        appendLedgerEntry(tx, {
          agreementId: agreement.id,
          type: "onchain_job.refunded_late_funding",
          payload: { standard: "erc8183", contract, job_id: p.jobId, settle_tx: txHash },
          createdAt: p.now,
        }),
      );
      throw new ApiError(
        409,
        "deadline_passed",
        "attached after the delivery deadline; the job was rejected and the buyer refunded",
      );
    }
    if (isUniqueViolation(err)) {
      throw new ApiError(409, "job_already_used", "that on-chain job already backs an agreement");
    }
    throw err;
  }
}
