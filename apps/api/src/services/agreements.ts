import {
  type Actor,
  type AgreementEvent,
  type AgreementSnapshot,
  hashValue,
  newId,
  type Outcome,
  type Spec,
  sha256Hex,
  specHash,
  type TransitionResult,
  transition,
} from "@proofdesk/core";
import { type Artifact, appendLedgerEntry, type Db, schema, type Tx } from "@proofdesk/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { ApiError, notFound } from "../errors.ts";

export type AgreementRow = typeof schema.agreements.$inferSelect;

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
  };
}

function specColumns(spec: Spec) {
  return {
    spec,
    specHash: specHash(spec),
    amountValue: spec.amount.value,
    currency: spec.amount.currency,
    deliveryDueAt: new Date(spec.delivery_due_at),
    appealWindowHours: spec.appeal_window_hours,
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
    metadata: Record<string, string>;
    now: Date;
  },
): Promise<AgreementRow> {
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
        buyer_ref: row.buyerRef,
        seller_ref: row.sellerRef,
        livemode: row.livemode,
      },
      createdAt: input.now,
    });
    return row;
  });
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
      .set({ ...specColumns(spec), version: current.version + 1, updatedAt: now })
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

async function lockAgreement(tx: Tx, id: string, scope: Scope): Promise<AgreementRow> {
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
  agreementId: string,
  event: AgreementEvent,
  actor: Actor,
  now: Date,
): Promise<Record<string, unknown>> {
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
      };
    case "RESOLVE_DISPUTE":
      return { outcome: outcomeToJson(event.outcome), reason: event.reason };
    case "SETTLE":
      return { settlement_ref: event.settlementRef, force: event.force };
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
    const records = await writeEventRecords(tx, agreementId, event, actor, now);

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
