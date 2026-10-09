import {
  type Actor,
  type AgreementEvent,
  type AgreementSnapshot,
  hashValue,
  newId,
  type Outcome,
  PRICING,
  type Spec,
  sameOutcome,
  sha256Hex,
  specHash,
  type TransitionResult,
  transition,
  usdCents,
} from "@proofdesk/core";
import {
  type Artifact,
  appendLedgerEntry,
  type Db,
  type SpecSource,
  schema,
  type Tx,
} from "@proofdesk/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { ApiError, notFound } from "../errors.ts";
import { recordDisputeFee } from "./billing.ts";

export type AgreementRow = typeof schema.agreements.$inferSelect;

/** Hold refs of jobs on other parties' ERC-8183 contracts (services/external-jobs.ts). */
export const EXTERNAL_HOLD_PREFIX = "erc8183:";

/** Standard ERC-8183 can only complete (pay all) or reject (refund all): no partial outcomes. */
export function supportsPartial(row: Pick<AgreementRow, "holdRef">): boolean {
  return !row.holdRef?.startsWith(EXTERNAL_HOLD_PREFIX);
}

/**
 * Live jobs above PRICING.directHoldMaxCents need a licensed escrow partner, so they can't be
 * funded with a card hold or an on-chain job. Test mode is unrestricted.
 */
export function assertDirectHoldAllowed(row: AgreementRow): void {
  if (row.amountValue <= 0) {
    throw new ApiError(422, "amount_required", "funding needs a spec amount above zero");
  }
  if (!row.livemode) return;
  const { cents } = usdCents(row.amountValue, row.currency);
  if (cents > PRICING.directHoldMaxCents) {
    throw new ApiError(
      422,
      "amount_requires_partner",
      `live jobs over $${(PRICING.directHoldMaxCents / 100).toLocaleString("en-US")} must be held by a licensed escrow partner, which isn't available yet; split the job or use Proof Desk for verification only`,
    );
  }
}

function eventOutcome(event: AgreementEvent): Outcome | null {
  return event.type === "DECIDE" || event.type === "RESOLVE_DISPUTE" || event.type === "REVIEW"
    ? event.outcome
    : null;
}

/** Platform keys only see their own agreements; ops (accountId undefined) sees all. */
export interface Scope {
  accountId?: string;
}

function scopedWhere(id: string, scope: Scope): SQL | undefined {
  return scope.accountId
    ? and(eq(schema.agreements.id, id), eq(schema.agreements.accountId, scope.accountId))
    : eq(schema.agreements.id, id);
}

export function snapshotOf(row: AgreementRow): AgreementSnapshot {
  return {
    status: row.status,
    specHash: row.specHash,
    deliveryDueAt: row.deliveryDueAt,
    appealWindowHours: row.appealWindowHours,
    outcome: row.outcome,
    decidedAt: row.decidedAt,
    disputeResolved: row.disputeResolved,
    reviewPending: row.reviewPending,
  };
}

/**
 * Spec columns for a write. `inputs` is never taken from the caller's spec: it always reflects
 * the source files actually stored (see services/inputs.ts), so a spec can't claim other inputs.
 */
export function specColumns(spec: Spec, inputs: Spec["inputs"] = undefined) {
  const { inputs: _callerInputs, ...rest } = spec;
  const stored: Spec = inputs?.length ? { ...rest, inputs } : rest;
  return {
    spec: stored,
    specHash: specHash(stored),
    amountValue: stored.amount.value,
    currency: stored.amount.currency,
    deliveryDueAt: new Date(stored.delivery_due_at),
    appealWindowHours: stored.appeal_window_hours,
  };
}

export async function createAgreement(
  db: Db,
  input: {
    accountId: string;
    livemode: boolean;
    buyerRef: string;
    sellerRef: string;
    spec: Spec;
    specSource?: SpecSource;
    metadata: Record<string, string>;
    now: Date;
  },
): Promise<AgreementRow> {
  const specSource = input.specSource ?? { kind: "manual" };
  const id = newId("agreement", input.now.getTime());
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.agreements)
      .values({
        id,
        accountId: input.accountId,
        livemode: input.livemode,
        buyerRef: input.buyerRef,
        sellerRef: input.sellerRef,
        status: "draft",
        metadata: input.metadata,
        specSource,
        createdAt: input.now,
        updatedAt: input.now,
        ...specColumns(input.spec),
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    await appendLedgerEntry(tx, {
      agreementId: id,
      type: "agreement.created",
      payload: {
        to: "draft",
        actor: { role: "platform", ref: input.accountId },
        spec_hash: row.specHash,
        spec_source: specSourceSummary(specSource),
        buyer_ref: row.buyerRef,
        seller_ref: row.sellerRef,
        livemode: row.livemode,
      },
      createdAt: input.now,
    });
    return row;
  });
}

/** Provenance for the ledger: who/what drafted the spec, without the open questions. */
function specSourceSummary(source: SpecSource): Record<string, unknown> {
  if (source.kind === "manual") return { kind: "manual" };
  return {
    kind: "drafted",
    model: source.model,
    prompt_version: source.prompt_version,
    ...(source.mandate ? { mandate: source.mandate } : {}),
  };
}

/** A drafted spec stays "drafted" after edits, flagged so we can measure how often buyers edit. */
function editedSource(source: SpecSource | null): SpecSource {
  return source?.kind === "drafted" ? { ...source, edited: true } : { kind: "manual" };
}

/** Specs are editable only while in draft; each edit changes the hash the buyer must approve. */
export async function replaceSpec(
  db: Db,
  id: string,
  scope: Scope,
  spec: Spec,
  now: Date,
): Promise<AgreementRow> {
  return db.transaction(async (tx) => {
    const current = await lockAgreement(tx, id, scope);
    if (current.status !== "draft") {
      throw new ApiError(
        409,
        "spec_locked",
        `the spec can't change once status is "${current.status}"`,
      );
    }
    const [row] = await tx
      .update(schema.agreements)
      .set({
        ...specColumns(spec, current.spec.inputs),
        specSource: editedSource(current.specSource),
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.agreements.id, id))
      .returning();
    if (!row) throw notFound("agreement");
    await appendLedgerEntry(tx, {
      agreementId: id,
      type: "agreement.spec_replaced",
      payload: {
        previous_spec_hash: current.specHash,
        spec_hash: row.specHash,
        version: row.version,
      },
      createdAt: now,
    });
    return row;
  });
}

export async function lockAgreement(tx: Tx, id: string, scope: Scope): Promise<AgreementRow> {
  const [row] = await tx
    .select()
    .from(schema.agreements)
    .where(scopedWhere(id, scope))
    .for("update")
    .limit(1);
  if (!row) throw notFound("agreement");
  return row;
}

export async function getAgreement(db: Db, id: string, scope: Scope): Promise<AgreementRow> {
  const [row] = await db.select().from(schema.agreements).where(scopedWhere(id, scope)).limit(1);
  if (!row) throw notFound("agreement");
  return row;
}

export async function listAgreements(
  db: Db,
  accountId: string,
  opts: { limit: number; status?: AgreementRow["status"] },
): Promise<AgreementRow[]> {
  const conditions = [eq(schema.agreements.accountId, accountId)];
  if (opts.status) conditions.push(eq(schema.agreements.status, opts.status));
  return db
    .select()
    .from(schema.agreements)
    .where(and(...conditions))
    .orderBy(desc(schema.agreements.createdAt), desc(schema.agreements.id))
    .limit(opts.limit);
}

/** Column changes that only some events make, beyond the state machine's patch. */
function eventColumns(event: AgreementEvent, now: Date): Partial<AgreementRow> {
  switch (event.type) {
    case "APPROVE_SPEC":
      return { specApprovedAt: now };
    case "FUND":
      return { holdRail: event.rail, holdRef: event.holdRef, fundedAt: now };
    case "SETTLE":
      return { settledAt: now, settlementRef: event.settlementRef };
    case "CANCEL":
      return { cancelledAt: now };
    default:
      return {};
  }
}

/** Records written alongside a transition; their ids go into the ledger entry. */
async function writeEventRecords(
  tx: Tx,
  current: AgreementRow,
  event: AgreementEvent,
  actor: Actor,
  now: Date,
): Promise<Record<string, unknown>> {
  const agreementId = current.id;
  switch (event.type) {
    case "DECIDE":
    case "MISS_DEADLINE": {
      const id = newId("decision", now.getTime());
      const isDeadline = event.type === "MISS_DEADLINE";
      await tx.insert(schema.decisions).values({
        id,
        agreementId,
        kind: isDeadline ? "deadline" : "verification",
        outcome: isDeadline ? { kind: "refund" } : event.outcome,
        decidedBy: isDeadline ? "auto" : event.decidedBy,
        actorRef: actor.ref,
        confidence: isDeadline ? null : event.confidence,
        reason: isDeadline ? "no delivery before the deadline" : event.reason,
        createdAt: now,
      });
      return { decision_id: id };
    }
    case "OPEN_DISPUTE": {
      const id = newId("dispute", now.getTime());
      await tx.insert(schema.disputes).values({
        id,
        agreementId,
        openedBy: actor.role as "buyer" | "seller",
        reason: event.reason,
        status: "open",
        openedAt: now,
      });
      return { dispute_id: id };
    }
    case "RESOLVE_DISPUTE": {
      const decisionId = newId("decision", now.getTime());
      await tx.insert(schema.decisions).values({
        id: decisionId,
        agreementId,
        kind: "dispute_resolution",
        outcome: event.outcome,
        decidedBy: "human",
        actorRef: actor.ref,
        confidence: null,
        reason: event.reason,
        createdAt: now,
      });
      const [dispute] = await tx
        .update(schema.disputes)
        .set({ status: "resolved", resolvedAt: now, resolutionDecisionId: decisionId })
        .where(
          and(eq(schema.disputes.agreementId, agreementId), eq(schema.disputes.status, "open")),
        )
        .returning({ id: schema.disputes.id });
      return { decision_id: decisionId, dispute_id: dispute?.id ?? null };
    }
    case "REVIEW": {
      const [auto] = await tx
        .select({ id: schema.decisions.id, outcome: schema.decisions.outcome })
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.agreementId, agreementId),
            eq(schema.decisions.decidedBy, "auto"),
          ),
        )
        .orderBy(desc(schema.decisions.createdAt), desc(schema.decisions.id))
        .limit(1);
      if (!auto) throw new ApiError(409, "no_review_pending", "no automatic decision to review");
      const [verification] = await tx
        .select({ id: schema.verifications.id })
        .from(schema.verifications)
        .where(eq(schema.verifications.agreementId, agreementId))
        .orderBy(desc(schema.verifications.createdAt), desc(schema.verifications.id))
        .limit(1);
      const reviewed = event.outcome ?? auto.outcome;
      const agreed = sameOutcome(reviewed, auto.outcome);
      let overrideId: string | null = null;
      if (!agreed) {
        overrideId = newId("decision", now.getTime());
        await tx.insert(schema.decisions).values({
          id: overrideId,
          agreementId,
          kind: "review_override",
          outcome: reviewed,
          decidedBy: "human",
          actorRef: actor.ref,
          confidence: null,
          reason: event.reason,
          createdAt: now,
        });
      }
      const reviewId = newId("review", now.getTime());
      await tx.insert(schema.decisionReviews).values({
        id: reviewId,
        agreementId,
        decisionId: auto.id,
        verificationId: verification?.id ?? null,
        autoOutcome: auto.outcome,
        reviewedOutcome: reviewed,
        agreed,
        overrideDecisionId: overrideId,
        reviewerRef: actor.ref,
        reason: event.reason,
        createdAt: now,
      });
      return {
        review_id: reviewId,
        agreed,
        ...(overrideId ? { decision_id: overrideId } : {}),
      };
    }
    default:
      return {};
  }
}

function ledgerType(eventType: AgreementEvent["type"]): string {
  return `agreement.${eventType.toLowerCase()}`;
}

/** Event fields for the ledger, in the API's snake_case. */
export function eventPayload(event: AgreementEvent): Record<string, unknown> {
  switch (event.type) {
    case "APPROVE_SPEC":
      return { spec_hash: event.specHash };
    case "CANCEL":
    case "ESCALATE":
    case "OPEN_DISPUTE":
      return { reason: event.reason };
    case "FUND":
      return { rail: event.rail, hold_ref: event.holdRef };
    case "DELIVER":
      return { delivery_id: event.deliveryId, manifest_hash: event.manifestHash };
    case "DECIDE":
      return {
        outcome: outcomeToJson(event.outcome),
        decided_by: event.decidedBy,
        confidence: event.confidence,
        reason: event.reason,
        ...(event.review ? { review_pending: true } : {}),
      };
    case "RESOLVE_DISPUTE":
      return { outcome: outcomeToJson(event.outcome), reason: event.reason };
    case "SETTLE":
      return { settlement_ref: event.settlementRef, force: event.force };
    case "REVIEW":
      return {
        outcome: event.outcome ? outcomeToJson(event.outcome) : null,
        reason: event.reason,
      };
    case "START_VERIFICATION":
    case "MISS_DEADLINE":
      return {};
  }
}

export function outcomeToJson(o: Outcome) {
  return o.kind === "partial"
    ? { kind: o.kind, release_percent: o.releasePercent }
    : { kind: o.kind };
}

/** A party role without a ref is resolved to the agreement's buyer_ref / seller_ref. */
export type ActorInput = Actor | { role: "buyer" | "seller"; ref?: undefined };

function resolveActor(row: AgreementRow, input: ActorInput): Actor {
  if (input.ref !== undefined) return input;
  return { role: input.role, ref: input.role === "buyer" ? row.buyerRef : row.sellerRef };
}

/**
 * The one way an agreement changes state: lock the row, run the pure state machine, write the
 * new state + any related records + a ledger entry, all in one transaction.
 * `beforeTransition` runs after the lock but before validation, for checks needing the row.
 */
export async function applyEvent(
  db: Db,
  params: {
    agreementId: string;
    scope: Scope;
    event: AgreementEvent;
    actor: ActorInput;
    now: Date;
    beforeTransition?: (row: AgreementRow) => void;
    afterTransition?: (tx: Tx, row: AgreementRow, result: TransitionResult) => Promise<void>;
  },
): Promise<AgreementRow> {
  const { agreementId, scope, event, now } = params;
  return db.transaction(async (tx) => {
    const current = await lockAgreement(tx, agreementId, scope);
    const actor = resolveActor(current, params.actor);
    if (eventOutcome(event)?.kind === "partial" && !supportsPartial(current)) {
      throw new ApiError(
        422,
        "partial_unsupported",
        "this agreement is funded by a standard ERC-8183 job, which can only pay the provider in full or refund the client in full",
      );
    }
    params.beforeTransition?.(current);
    const result = transition(snapshotOf(current), event, actor, now);

    const [row] = await tx
      .update(schema.agreements)
      .set({
        ...result.patch,
        ...eventColumns(event, now),
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.agreements.id, agreementId))
      .returning();
    if (!row) throw notFound("agreement");

    await params.afterTransition?.(tx, row, result);
    const records = await writeEventRecords(tx, current, event, actor, now);
    if (event.type === "RESOLVE_DISPUTE") {
      await recordDisputeFee(tx, {
        agreement: row,
        ref: String(records.dispute_id ?? records.decision_id),
        outcome: event.outcome,
        now,
      });
    }

    await appendLedgerEntry(tx, {
      agreementId,
      type: ledgerType(event.type),
      payload: {
        from: result.from,
        to: result.to,
        actor,
        version: row.version,
        ...eventPayload(event),
        ...records,
      },
      createdAt: now,
    });
    return row;
  });
}

export interface ArtifactInput {
  name: string;
  media_type: string;
  content: string;
}

/** Deliveries are content-addressed: the manifest hash covers every artifact's name, type and bytes. */
export function buildDelivery(artifacts: ArtifactInput[]): {
  artifacts: Artifact[];
  manifestHash: string;
} {
  const hashed: Artifact[] = artifacts.map((a) => ({
    name: a.name,
    mediaType: a.media_type,
    content: a.content,
    sha256: sha256Hex(a.content),
  }));
  const manifestHash = hashValue(
    hashed.map((a) => ({ name: a.name, media_type: a.mediaType, sha256: a.sha256 })),
  );
  return { artifacts: hashed, manifestHash };
}

export async function submitDelivery(
  db: Db,
  params: {
    agreementId: string;
    scope: Scope;
    actor: ActorInput;
    artifacts: ArtifactInput[];
    now: Date;
  },
) {
  const { artifacts, manifestHash } = buildDelivery(params.artifacts);
  const deliveryId = newId("delivery", params.now.getTime());
  const row = await applyEvent(db, {
    agreementId: params.agreementId,
    scope: params.scope,
    actor: params.actor,
    now: params.now,
    event: { type: "DELIVER", deliveryId, manifestHash },
    afterTransition: async (tx) => {
      await tx.insert(schema.deliveries).values({
        id: deliveryId,
        agreementId: params.agreementId,
        artifacts,
        manifestHash,
        submittedAt: params.now,
      });
    },
  });
  return { agreement: row, deliveryId, manifestHash };
}

export async function listDeliveries(db: Db, agreementId: string) {
  return db
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.agreementId, agreementId))
    .orderBy(desc(schema.deliveries.submittedAt));
}
