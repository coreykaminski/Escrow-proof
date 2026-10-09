import {
  authorizationTypedData,
  ChainError,
  type ChainGateway,
  fundingCalls,
  type JobStatus,
  type JobTerms,
  releaseBasisPoints,
  splitBudget,
} from "@proofdesk/chain";
import { type Actor, newId, type Outcome, TransitionError, transition } from "@proofdesk/core";
import { appendLedgerEntry, type Db, listLedgerForAgreement, schema } from "@proofdesk/db";
import { and, eq, inArray } from "drizzle-orm";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import { ApiError } from "../errors.ts";
import {
  type AgreementRow,
  applyEvent,
  assertDirectHoldAllowed,
  getAgreement,
  type Scope,
  snapshotOf,
} from "./agreements.ts";

export type OnchainJobRow = typeof schema.onchainJobs.$inferSelect;

const SYSTEM: Actor = { role: "system", ref: "onchain" };
const HOUR_MS = 3_600_000;
/** On-chain jobs only hold the stablecoin the contract was deployed for. */
export const ONCHAIN_CURRENCY = "usdc";
/** After the decision window, extra time for human review and disputes before the buyer can reclaim. */
const REVIEW_BUFFER_HOURS = 7 * 24;

export function chainUnavailable(): never {
  throw new ApiError(503, "chain_unavailable", "the stablecoin rail isn't configured");
}

// ---------------------------------------------------------------------------------------------
// Seller wallets
// ---------------------------------------------------------------------------------------------

export async function getSellerWallet(db: Db, accountId: string, sellerRef: string) {
  const [row] = await db
    .select()
    .from(schema.sellerWallets)
    .where(
      and(
        eq(schema.sellerWallets.accountId, accountId),
        eq(schema.sellerWallets.sellerRef, sellerRef),
      ),
    )
    .limit(1);
  return row;
}

/** Sets (or replaces) the seller's payout address. Jobs already issued keep their provider. */
export async function setSellerWallet(
  db: Db,
  p: { accountId: string; sellerRef: string; address: string; now: Date },
) {
  if (!isAddress(p.address, { strict: false })) {
    throw new ApiError(400, "validation_error", "address must be a 0x-prefixed EVM address");
  }
  const address = getAddress(p.address);
  const [row] = await db
    .insert(schema.sellerWallets)
    .values({
      id: newId("wallet", p.now.getTime()),
      accountId: p.accountId,
      sellerRef: p.sellerRef,
      address,
      createdAt: p.now,
      updatedAt: p.now,
    })
    .onConflictDoUpdate({
      target: [schema.sellerWallets.accountId, schema.sellerWallets.sellerRef],
      set: { address, updatedAt: p.now },
    })
    .returning();
  if (!row) throw new Error("seller wallet upsert failed");
  return row;
}

// ---------------------------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------------------------

export async function getOnchainJob(db: Db, agreementId: string) {
  const [row] = await db
    .select()
    .from(schema.onchainJobs)
    .where(eq(schema.onchainJobs.agreementId, agreementId))
    .limit(1);
  return row;
}

/** The job's on-chain expiry: delivery deadline + a day to verify + appeal window + review buffer. */
export function onchainExpiry(a: Pick<AgreementRow, "deliveryDueAt" | "appealWindowHours">): Date {
  const ms = a.deliveryDueAt.getTime() + (24 + a.appealWindowHours + REVIEW_BUFFER_HOURS) * HOUR_MS;
  return new Date(Math.ceil(ms / 1000) * 1000);
}

export function termsOf(row: OnchainJobRow, client: Address): JobTerms {
  return {
    client,
    provider: row.provider as Address,
    evaluator: row.evaluator as Address,
    expiredAt: BigInt(Math.floor(row.expiresAt.getTime() / 1000)),
    description: row.description,
    budget: BigInt(row.budget),
  };
}

/**
 * Issues (once) the fixed terms of the agreement's on-chain job and returns how to fund it:
 * the two wallet transactions, and — when the buyer's address is known — the EIP-3009 typed
 * data to sign for gasless funding.
 */
export async function prepareOnchainJob(
  db: Db,
  chain: ChainGateway,
  p: { agreementId: string; scope: Scope; client?: string; now: Date },
) {
  const agreement = await getAgreement(db, p.agreementId, p.scope);
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
      `on-chain funding holds ${ONCHAIN_CURRENCY.toUpperCase()}; this agreement is in ${agreement.currency.toUpperCase()}`,
    );
  }

  let row = await getOnchainJob(db, agreement.id);
  if (!row) {
    if (agreement.status !== "spec_approved") {
      throw new ApiError(
        409,
        "invalid_transition",
        `can't fund an agreement in status "${agreement.status}"`,
      );
    }
    assertDirectHoldAllowed(agreement);
    if (agreement.holdRail === "card" || (await hasCardHold(db, agreement.id))) {
      throw new ApiError(409, "already_funding", "this agreement is being funded by card");
    }
    const wallet = await getSellerWallet(db, agreement.accountId, agreement.sellerRef);
    if (!wallet) {
      throw new ApiError(
        409,
        "seller_wallet_missing",
        `seller "${agreement.sellerRef}" has no payout address; set one with PUT /v1/sellers/${encodeURIComponent(agreement.sellerRef)}/wallet`,
      );
    }
    if (getAddress(wallet.address) === cfg.evaluator) {
      throw new ApiError(400, "validation_error", "the seller's address can't be the evaluator");
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.onchainJobs)
        .values({
          id: newId("onchainJob", p.now.getTime()),
          agreementId: agreement.id,
          chainId: cfg.chainId,
          contract: cfg.contract,
          provider: wallet.address,
          evaluator: cfg.evaluator,
          // Binds the job to this agreement and the exact spec both sides approved.
          description: `proofdesk:v1:${agreement.id}:${agreement.specHash}`,
          budget: agreement.amountValue,
          expiresAt: onchainExpiry(agreement),
          status: "awaiting_funding",
          createdAt: p.now,
          updatedAt: p.now,
        })
        .onConflictDoNothing();
      await appendLedgerEntry(tx, {
        agreementId: agreement.id,
        type: "onchain_job.terms_issued",
        payload: { chain_id: cfg.chainId, contract: cfg.contract, provider: wallet.address },
        createdAt: p.now,
      });
    });
    row = (await getOnchainJob(db, agreement.id)) as OnchainJobRow;
  }

  if (row.kind === "external") {
    throw new ApiError(
      409,
      "already_funding",
      "this agreement is funded by a job on another ERC-8183 contract",
    );
  }
  const placeholder = "0x0000000000000000000000000000000000000000" as Address;
  const { client: _c, ...terms } = termsOf(row, placeholder);
  let typedData: ReturnType<typeof authorizationTypedData> | null = null;
  if (p.client !== undefined) {
    if (!isAddress(p.client, { strict: false })) {
      throw new ApiError(400, "validation_error", "client must be a 0x-prefixed EVM address");
    }
    typedData = authorizationTypedData(
      cfg,
      await chain.tokenDomain(),
      termsOf(row, getAddress(p.client)),
      0n,
      terms.expiredAt,
    );
  }
  return {
    row,
    config: cfg,
    terms,
    calls: fundingCalls(cfg, terms),
    typedData,
    agreement,
  };
}

async function hasCardHold(db: Db, agreementId: string) {
  const [h] = await db
    .select({ id: schema.holds.id })
    .from(schema.holds)
    .where(eq(schema.holds.agreementId, agreementId))
    .limit(1);
  return Boolean(h);
}

/**
 * Funds the agreement from a transaction the buyer sent. Trusts nothing in the request: the job
 * is read back from the chain and must match the issued terms exactly.
 */
export async function confirmOnchainFunding(
  db: Db,
  chain: ChainGateway,
  p: { agreementId: string; scope: Scope; txHash: string; now: Date },
): Promise<{ row: OnchainJobRow; agreement: AgreementRow }> {
  const agreement = await getAgreement(db, p.agreementId, p.scope);
  const row = await getOnchainJob(db, agreement.id);
  if (!row) {
    throw new ApiError(409, "no_onchain_job", "request funding terms first (POST …/onchain-job)");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.txHash)) {
    throw new ApiError(400, "validation_error", "tx_hash must be a 32-byte hex transaction hash");
  }
  if (row.status !== "awaiting_funding") {
    if (row.fundTx?.toLowerCase() === p.txHash.toLowerCase()) return { row, agreement };
    throw new ApiError(409, "already_funded", "this agreement's job is already funded");
  }
  const jobId = await chain.jobFromTx(p.txHash as Hex);
  if (jobId === null) {
    throw new ApiError(
      422,
      "funding_not_found",
      "that transaction isn't a successful funding of the job contract (yet); retry once it's mined",
    );
  }
  return recordFunding(db, chain, { row, agreement, jobId, txHash: p.txHash, now: p.now });
}

/** Gasless funding: relays the buyer's signed EIP-3009 authorization, then records it. */
export async function relayOnchainFunding(
  db: Db,
  chain: ChainGateway,
  p: {
    agreementId: string;
    scope: Scope;
    client: string;
    validAfter: bigint;
    validBefore: bigint;
    signature: string;
    now: Date;
  },
) {
  const { row, agreement } = await prepareOnchainJob(db, chain, {
    agreementId: p.agreementId,
    scope: p.scope,
    client: p.client,
    now: p.now,
  });
  if (row.status !== "awaiting_funding") {
    throw new ApiError(409, "already_funded", "this agreement's job is already funded");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(p.signature)) {
    throw new ApiError(400, "validation_error", "signature must be a 65-byte hex signature");
  }
  let relayed: { txHash: Hex; jobId: bigint };
  try {
    relayed = await chain.relayFunding({
      terms: termsOf(row, getAddress(p.client)),
      validAfter: p.validAfter,
      validBefore: p.validBefore,
      signature: p.signature as Hex,
    });
  } catch (err) {
    if (err instanceof ChainError && !err.retryable) {
      throw new ApiError(422, "authorization_rejected", err.message);
    }
    throw err;
  }
  return recordFunding(db, chain, {
    row,
    agreement,
    jobId: relayed.jobId,
    txHash: relayed.txHash,
    now: p.now,
  });
}

async function recordFunding(
  db: Db,
  chain: ChainGateway,
  p: { row: OnchainJobRow; agreement: AgreementRow; jobId: bigint; txHash: string; now: Date },
) {
  const { row } = p;
  const job = await chain.getJob(p.jobId);
  const cfg = await chain.config();
  const mismatches = [
    job.status !== "funded" && job.status !== "submitted" && `status is ${job.status}`,
    getAddress(job.provider) !== getAddress(row.provider) && "provider",
    getAddress(job.evaluator) !== getAddress(row.evaluator) && "evaluator",
    job.description !== row.description && "description",
    job.budget !== BigInt(row.budget) && "budget",
    job.expiredAt !== BigInt(Math.floor(row.expiresAt.getTime() / 1000)) && "expiry",
    (cfg.chainId !== row.chainId || cfg.contract !== row.contract) && "contract",
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new ApiError(
      422,
      "terms_mismatch",
      `the on-chain job doesn't match the agreement's terms (${mismatches.join(", ")})`,
    );
  }

  const holdRef = `${row.chainId}:${row.contract}:${p.jobId}`;
  let agreement: AgreementRow;
  try {
    agreement = await applyEvent(db, {
      agreementId: row.agreementId,
      scope: {},
      event: { type: "FUND", rail: "onchain", holdRef },
      actor: SYSTEM,
      now: p.now,
      afterTransition: async (tx) => {
        const claimed = await tx
          .update(schema.onchainJobs)
          .set({
            status: "funded",
            jobId: p.jobId.toString(),
            client: getAddress(job.client),
            fundTx: p.txHash,
            updatedAt: p.now,
          })
          .where(
            and(
              eq(schema.onchainJobs.id, row.id),
              eq(schema.onchainJobs.status, "awaiting_funding"),
            ),
          )
          .returning({ id: schema.onchainJobs.id });
        if (claimed.length === 0) {
          throw new ApiError(409, "already_funded", "this agreement's job is already funded");
        }
        await appendLedgerEntry(tx, {
          agreementId: row.agreementId,
          type: "onchain_job.funded",
          payload: {
            chain_id: row.chainId,
            contract: row.contract,
            job_id: p.jobId.toString(),
            client: getAddress(job.client),
            budget: row.budget,
            tx_hash: p.txHash,
          },
          createdAt: p.now,
        });
      },
    });
  } catch (err) {
    if (err instanceof TransitionError && err.code === "deadline_passed") {
      // Funded after the delivery deadline: refund on-chain now rather than leave the buyer's
      // money locked until the job expires (the card rail cancels late holds the same way).
      await refundLateFunding(db, chain, { row, jobId: p.jobId, txHash: p.txHash, now: p.now });
      throw new ApiError(
        409,
        "deadline_passed",
        "funded after the delivery deadline; the funds were returned to the buyer",
      );
    }
    if (isUniqueViolation(err)) {
      throw new ApiError(409, "job_already_used", "that on-chain job already backs an agreement");
    }
    throw err;
  }
  return { row: (await getOnchainJob(db, row.agreementId)) as OnchainJobRow, agreement };
}

async function refundLateFunding(
  db: Db,
  chain: ChainGateway,
  p: { row: OnchainJobRow; jobId: bigint; txHash: string; now: Date },
) {
  const { txHash: settleTx } = await chain.settle({
    jobId: p.jobId,
    releaseBP: 0,
    reason: `0x${"0".repeat(64)}`,
  });
  await db.transaction(async (tx) => {
    await tx
      .update(schema.onchainJobs)
      .set({
        status: "settled",
        jobId: p.jobId.toString(),
        fundTx: p.txHash,
        settleTx,
        settlement: { late_funding_refunded: true, buyer_refund: p.row.budget },
        updatedAt: p.now,
      })
      .where(eq(schema.onchainJobs.id, p.row.id));
    await appendLedgerEntry(tx, {
      agreementId: p.row.agreementId,
      type: "onchain_job.refunded_late_funding",
      payload: { job_id: p.jobId.toString(), fund_tx: p.txHash, settle_tx: settleTx },
      createdAt: p.now,
    });
  });
}

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------------------------

/** The ledger hash of the decision being settled; it goes on-chain as the settle `reason`. */
async function decisionHash(db: Db, agreementId: string): Promise<Hex> {
  const entries = await listLedgerForAgreement(db, agreementId);
  const decision = entries
    .filter((e) =>
      [
        "agreement.decide",
        "agreement.resolve_dispute",
        "agreement.miss_deadline",
        "agreement.review",
      ].includes(e.type),
    )
    .at(-1);
  if (!decision) throw new ApiError(409, "invalid_transition", "nothing to settle");
  return `0x${decision.entryHash}` as Hex;
}

/**
 * Settles the agreement's job on-chain as decided, then marks the agreement settled. The
 * contract enforces the rest: only our evaluator can settle, once, and never pay the seller
 * after expiry. A retry after a lost response finds the job already ended and just records it.
 */
export async function settleOnchain(
  db: Db,
  chain: ChainGateway,
  p: { agreement: AgreementRow; actor: Actor; force: boolean; now: Date },
): Promise<AgreementRow> {
  const { agreement } = p;
  transition(
    snapshotOf(agreement),
    { type: "SETTLE", settlementRef: "pending", force: p.force },
    p.actor,
    p.now,
  );
  const outcome = agreement.outcome as Outcome | null;
  const row = await getOnchainJob(db, agreement.id);
  if (!outcome || !row?.jobId) throw new ApiError(409, "invalid_transition", "nothing to settle");

  // A job keeps the evaluator it was funded with: after a key rotation, the old key must stay
  // available until its jobs close (docs/security/evaluator-keys.md).
  const signer = (await chain.config()).evaluator;
  if (getAddress(row.evaluator) !== getAddress(signer)) {
    throw new ApiError(
      409,
      "evaluator_key_mismatch",
      `this job's evaluator is ${row.evaluator}, but this server signs as ${signer}; settle it with the key that was active when it was funded`,
    );
  }
  const reason = await decisionHash(db, agreement.id);
  const { settleTx, endedAs, settlement } =
    row.kind === "external"
      ? await settleExternalJob(chain, row, outcome, reason)
      : await settleNativeJob(chain, row, outcome, reason);
  return applyEvent(db, {
    agreementId: agreement.id,
    scope: {},
    event: {
      type: "SETTLE",
      settlementRef: settleTx ?? `${row.chainId}:${row.contract}:${row.jobId}`,
      force: p.force,
    },
    actor: p.actor,
    now: p.now,
    afterTransition: async (tx) => {
      await tx
        .update(schema.onchainJobs)
        .set({
          status: endedAs === "expired" ? "expired" : "settled",
          settleTx,
          settlement,
          updatedAt: p.now,
        })
        .where(eq(schema.onchainJobs.id, row.id));
      await appendLedgerEntry(tx, {
        agreementId: agreement.id,
        type: "onchain_job.settled",
        payload: { job_id: row.jobId, ...settlement },
        createdAt: p.now,
      });
    },
  });
}

type Settled = {
  settleTx: string | null;
  endedAs: JobStatus;
  settlement: Record<string, unknown>;
};

const unsettleable = (message: string) => new ApiError(409, "hold_unsettleable", message);

async function sendOrExplain(fn: () => Promise<{ txHash: Hex }>): Promise<string> {
  try {
    return (await fn()).txHash;
  } catch (err) {
    if (err instanceof ChainError && !err.retryable) throw unsettleable(err.message);
    throw err;
  }
}

/** Our ProofDeskJobs contract: one `settle` call with the release share (partials allowed). */
async function settleNativeJob(
  chain: ChainGateway,
  row: OnchainJobRow,
  outcome: Outcome,
  reason: Hex,
): Promise<Settled> {
  const jobId = BigInt(row.jobId as string);
  const releaseBP = releaseBasisPoints(outcome);
  const job = await chain.getJob(jobId);
  let settleTx: string | null = null;
  let endedAs = job.status;

  if (job.status === "funded" || job.status === "submitted") {
    settleTx = await sendOrExplain(() => chain.settle({ jobId, releaseBP, reason }));
    endedAs = releaseBP === 0 ? "rejected" : "completed";
  } else if (job.status === "expired" || job.status === "rejected") {
    // Already refunded on-chain (expiry claim, or an earlier attempt of this settlement).
    if (releaseBP > 0) {
      throw unsettleable(
        `the job already ended on-chain as ${job.status} (buyer refunded) but the decision pays the seller`,
      );
    }
  } else if (job.status === "completed") {
    if (releaseBP === 0) {
      throw unsettleable("the job was completed on-chain but the decision is a refund");
    }
  } else {
    throw unsettleable(`the job is ${job.status} on-chain`);
  }

  const feeBP = await chain.jobFeeBP(jobId);
  const split = splitBudget(BigInt(row.budget), releaseBP, feeBP);
  return {
    settleTx,
    endedAs,
    settlement: {
      release_bp: releaseBP,
      release: Number(split.released),
      fee: Number(split.fee),
      seller_payout: Number(split.toProvider),
      buyer_refund: Number(split.toClient),
      job_status: endedAs,
      ...(settleTx ? { settle_tx: settleTx } : {}),
    },
  };
}

/**
 * Someone else's ERC-8183 contract: `complete` pays the provider in full, `reject` refunds the
 * client in full. `complete` needs the provider to have called `submit` first.
 */
async function settleExternalJob(
  chain: ChainGateway,
  row: OnchainJobRow,
  outcome: Outcome,
  reason: Hex,
): Promise<Settled> {
  if (outcome.kind === "partial") {
    throw unsettleable("a standard ERC-8183 job can't settle a partial outcome");
  }
  const contract = getAddress(row.contract);
  const jobId = BigInt(row.jobId as string);
  const release = outcome.kind === "release";
  const job = await chain.getJobAt(contract, jobId);
  let settleTx: string | null = null;
  let endedAs = job.status;

  if (release) {
    if (job.status === "submitted") {
      settleTx = await sendOrExplain(() => chain.complete({ contract, jobId, reason }));
      endedAs = "completed";
    } else if (job.status === "funded") {
      throw new ApiError(
        409,
        "provider_not_submitted",
        `the decision pays the provider, but the provider hasn't called submit(${jobId}, …) on ${contract} yet; ERC-8183 only completes submitted jobs`,
      );
    } else if (job.status !== "completed") {
      throw unsettleable(
        `the job already ended on-chain as ${job.status} (client refunded) but the decision pays the provider`,
      );
    }
  } else if (job.status === "funded" || job.status === "submitted") {
    settleTx = await sendOrExplain(() => chain.reject({ contract, jobId, reason }));
    endedAs = "rejected";
  } else if (job.status === "completed") {
    throw unsettleable("the job was completed on-chain but the decision is a refund");
  } else if (job.status !== "expired" && job.status !== "rejected") {
    throw unsettleable(`the job is ${job.status} on-chain`);
  }

  const budget = row.budget;
  return {
    settleTx,
    endedAs,
    settlement: {
      standard: "erc8183",
      release_bp: release ? 10_000 : 0,
      release: release ? budget : 0,
      // Paid by the job contract, minus any fee that contract itself charges.
      seller_payout: release ? budget : 0,
      buyer_refund: release ? 0 : budget,
      fee: 0,
      job_status: endedAs,
      ...(settleTx ? { settle_tx: settleTx } : {}),
    },
  };
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

/** Funded jobs whose agreement must settle soon or the buyer can reclaim the funds on-chain. */
export async function expiringOnchainJobs(db: Db, now: Date, marginHours = 24) {
  const horizon = now.getTime() + marginHours * HOUR_MS;
  const rows = await db
    .select({ job: schema.onchainJobs, status: schema.agreements.status })
    .from(schema.onchainJobs)
    .innerJoin(schema.agreements, eq(schema.agreements.id, schema.onchainJobs.agreementId))
    .where(
      and(
        eq(schema.onchainJobs.status, "funded"),
        inArray(schema.agreements.status, [...OPEN_STATES]),
      ),
    );
  return rows.filter((r) => r.job.expiresAt.getTime() < horizon);
}

/** Records jobs that ended on-chain without us (the buyer reclaimed an expired job). */
export async function syncOnchainJobs(db: Db, chain: ChainGateway, now: Date) {
  const funded = await db
    .select()
    .from(schema.onchainJobs)
    .where(eq(schema.onchainJobs.status, "funded"));
  const expired: string[] = [];
  for (const row of funded) {
    if (!row.jobId || row.expiresAt.getTime() > now.getTime()) continue;
    const job =
      row.kind === "external"
        ? await chain.getJobAt(getAddress(row.contract), BigInt(row.jobId))
        : await chain.getJob(BigInt(row.jobId));
    if (job.status !== "expired") continue;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.onchainJobs)
        .set({ status: "expired", updatedAt: now })
        .where(eq(schema.onchainJobs.id, row.id));
      await appendLedgerEntry(tx, {
        agreementId: row.agreementId,
        type: "onchain_job.expired",
        payload: { job_id: row.jobId, refunded_to: job.client, amount: row.budget },
        createdAt: now,
      });
    });
    expired.push(row.agreementId);
  }
  return expired;
}
