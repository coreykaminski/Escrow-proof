import { appealWindowEndsAt, lintSpec } from "@proofdesk/core";
import type { schema } from "@proofdesk/db";
import { type AgreementRow, outcomeToJson, snapshotOf } from "./services/agreements.ts";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function agreementJson(row: AgreementRow) {
  return {
    id: row.id,
    object: "agreement",
    livemode: row.livemode,
    status: row.status,
    buyer_ref: row.buyerRef,
    seller_ref: row.sellerRef,
    spec: row.spec,
    spec_hash: row.specHash,
    spec_source: row.specSource,
    /** Advisory: criteria a verifier would struggle to decide. Recomputed on every read. */
    spec_warnings: lintSpec(row.spec),
    spec_approved_at: iso(row.specApprovedAt),
    amount: { value: row.amountValue, currency: row.currency },
    delivery_due_at: iso(row.deliveryDueAt),
    hold: row.holdRail
      ? { rail: row.holdRail, ref: row.holdRef, funded_at: iso(row.fundedAt) }
      : null,
    outcome: row.outcome ? outcomeToJson(row.outcome) : null,
    decided_at: iso(row.decidedAt),
    appeal_window_hours: row.appealWindowHours,
    appeal_window_ends_at: iso(appealWindowEndsAt(snapshotOf(row))),
    dispute_resolved: row.disputeResolved,
    settled_at: iso(row.settledAt),
    settlement_ref: row.settlementRef,
    cancelled_at: iso(row.cancelledAt),
    metadata: row.metadata,
    version: row.version,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function deliveryJson(row: typeof schema.deliveries.$inferSelect, includeContent: boolean) {
  return {
    id: row.id,
    object: "delivery",
    agreement_id: row.agreementId,
    manifest_hash: row.manifestHash,
    submitted_at: iso(row.submittedAt),
    artifacts: row.artifacts.map((a) => ({
      name: a.name,
      media_type: a.mediaType,
      sha256: a.sha256,
      ...(includeContent ? { content: a.content } : {}),
    })),
  };
}

export function ledgerEntryJson(row: typeof schema.ledgerEntries.$inferSelect) {
  return {
    seq: row.seq,
    type: row.type,
    agreement_id: row.agreementId,
    payload: JSON.parse(row.payload) as unknown,
    created_at: row.createdAt,
    prev_hash: row.prevHash,
    entry_hash: row.entryHash,
  };
}

export function inputJson(
  row: typeof schema.agreementInputs.$inferSelect,
  includeContent: boolean,
) {
  return {
    id: row.id,
    object: "input",
    name: row.name,
    media_type: row.mediaType,
    sha256: row.sha256,
    created_at: iso(row.createdAt),
    ...(includeContent ? { content: row.content } : {}),
  };
}

export function verificationJson(row: typeof schema.verifications.$inferSelect) {
  return {
    id: row.id,
    object: "verification",
    agreement_id: row.agreementId,
    delivery_id: row.deliveryId,
    engine_version: row.engineVersion,
    action: row.action,
    outcome: row.outcome ? outcomeToJson(row.outcome) : null,
    confidence: row.confidence,
    report_hash: row.reportHash,
    report: row.report,
    created_at: iso(row.createdAt),
  };
}
