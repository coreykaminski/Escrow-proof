/**
 * Agreement lifecycle. Pure: given a snapshot, an event, who's acting and the time, it either
 * returns the next state + field changes or throws. The DB layer applies the result and writes a
 * ledger entry in the same transaction, so no state change can happen without being recorded.
 *
 *   draft          --APPROVE_SPEC-->        spec_approved
 *   draft|spec_approved --CANCEL-->         cancelled
 *   spec_approved  --FUND-->                funded
 *   funded         --DELIVER-->             delivered   (DELIVER again = redelivery)
 *   funded         --MISS_DEADLINE-->       decided     (refund)
 *   delivered      --START_VERIFICATION-->  verifying
 *   verifying      --ESCALATE-->            escalated
 *   verifying|escalated --DECIDE-->         decided     (auto only from verifying; human from either)
 *   decided        --OPEN_DISPUTE-->        disputed    (within appeal window, by the losing side)
 *   disputed       --RESOLVE_DISPUTE-->     decided     (final; no second appeal)
 *   decided        --SETTLE-->              settled     (after appeal window, or forced)
 */

export const AGREEMENT_STATES = [
  "draft",
  "spec_approved",
  "funded",
  "delivered",
  "verifying",
  "escalated",
  "decided",
  "disputed",
  "settled",
  "cancelled",
] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

export const TERMINAL_STATES: readonly AgreementState[] = ["settled", "cancelled"];

export type ActorRole = "buyer" | "seller" | "ops" | "system";

export type Outcome =
  | { kind: "release" }
  | { kind: "refund" }
  | { kind: "partial"; releasePercent: number };

export type HoldRail = "test" | "card";

export interface AgreementSnapshot {
  status: AgreementState;
  specHash: string | null;
  deliveryDueAt: Date | null;
  appealWindowHours: number;
  outcome: Outcome | null;
  decidedAt: Date | null;
  disputeResolved: boolean;
}

export type AgreementEvent =
  | { type: "APPROVE_SPEC"; specHash: string }
  | { type: "CANCEL"; reason: string }
  | { type: "FUND"; rail: HoldRail; holdRef: string }
  | { type: "DELIVER"; deliveryId: string; manifestHash: string }
  | { type: "START_VERIFICATION" }
  | { type: "ESCALATE"; reason: string }
  | {
      type: "DECIDE";
      outcome: Outcome;
      decidedBy: "auto" | "human";
      confidence: number | null;
      reason: string;
    }
  | { type: "MISS_DEADLINE" }
  | { type: "OPEN_DISPUTE"; reason: string }
  | { type: "RESOLVE_DISPUTE"; outcome: Outcome; reason: string }
  | { type: "SETTLE"; settlementRef: string; force: boolean };

export type EventType = AgreementEvent["type"];

export interface Actor {
  role: ActorRole;
  /** Who: account id, external user ref, or reviewer id. */
  ref: string;
}

export interface TransitionResult {
  from: AgreementState;
  to: AgreementState;
  /** Only these fields are ever changed by a transition; the rest of the snapshot is fixed. */
  patch: { status: AgreementState } & Partial<
    Pick<AgreementSnapshot, "outcome" | "decidedAt" | "disputeResolved">
  >;
}

export type TransitionErrorCode =
  | "invalid_transition"
  | "forbidden_actor"
  | "spec_hash_mismatch"
  | "deadline_passed"
  | "deadline_not_passed"
  | "appeal_window_closed"
  | "appeal_window_open"
  | "dispute_already_resolved"
  | "nothing_to_dispute"
  | "invalid_outcome";

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

interface Rule {
  from: readonly AgreementState[];
  actors: readonly ActorRole[];
}

/** Which states each event may fire from, and who may fire it. Guards below add the rest. */
export const RULES: Record<EventType, Rule> = {
  APPROVE_SPEC: { from: ["draft"], actors: ["buyer"] },
  CANCEL: { from: ["draft", "spec_approved"], actors: ["buyer", "seller", "ops"] },
  FUND: { from: ["spec_approved"], actors: ["buyer", "system"] },
  DELIVER: { from: ["funded", "delivered"], actors: ["seller"] },
  START_VERIFICATION: { from: ["delivered"], actors: ["system", "ops"] },
  ESCALATE: { from: ["verifying"], actors: ["system"] },
  DECIDE: { from: ["verifying", "escalated"], actors: ["system", "ops"] },
  MISS_DEADLINE: { from: ["funded"], actors: ["system", "ops"] },
  OPEN_DISPUTE: { from: ["decided"], actors: ["buyer", "seller"] },
  RESOLVE_DISPUTE: { from: ["disputed"], actors: ["ops"] },
  SETTLE: { from: ["decided"], actors: ["system", "ops"] },
};

const HOUR_MS = 3_600_000;

export function appealWindowEndsAt(s: AgreementSnapshot): Date | null {
  if (!s.decidedAt) return null;
  return new Date(s.decidedAt.getTime() + s.appealWindowHours * HOUR_MS);
}

function assertOutcome(outcome: Outcome): void {
  if (outcome.kind === "partial") {
    const p = outcome.releasePercent;
    if (!Number.isInteger(p) || p < 1 || p > 99) {
      throw new TransitionError(
        "invalid_outcome",
        "partial releasePercent must be an integer 1-99 (use release or refund for 100/0)",
      );
    }
  }
}

export function transition(
  s: AgreementSnapshot,
  event: AgreementEvent,
  actor: Actor,
  now: Date,
): TransitionResult {
  const rule = RULES[event.type];
  if (!rule.from.includes(s.status)) {
    throw new TransitionError(
      "invalid_transition",
      `${event.type} is not allowed from status "${s.status}"`,
    );
  }
  if (!rule.actors.includes(actor.role)) {
    throw new TransitionError(
      "forbidden_actor",
      `${actor.role} may not perform ${event.type} (allowed: ${rule.actors.join(", ")})`,
    );
  }

  const from = s.status;
  const pastDeadline = s.deliveryDueAt !== null && now.getTime() > s.deliveryDueAt.getTime();

  switch (event.type) {
    case "APPROVE_SPEC":
      // The approver must confirm the exact spec they saw; a spec edited in between won't match.
      if (s.specHash === null || s.specHash !== event.specHash) {
        throw new TransitionError(
          "spec_hash_mismatch",
          "approved spec hash does not match the agreement's current spec",
        );
      }
      return { from, to: "spec_approved", patch: { status: "spec_approved" } };

    case "CANCEL":
      return { from, to: "cancelled", patch: { status: "cancelled" } };

    case "FUND":
      if (pastDeadline) {
        throw new TransitionError("deadline_passed", "cannot fund after the delivery deadline");
      }
      return { from, to: "funded", patch: { status: "funded" } };

    case "DELIVER":
      if (pastDeadline) {
        throw new TransitionError("deadline_passed", "delivery deadline has passed");
      }
      return { from, to: "delivered", patch: { status: "delivered" } };

    case "START_VERIFICATION":
      return { from, to: "verifying", patch: { status: "verifying" } };

    case "ESCALATE":
      return { from, to: "escalated", patch: { status: "escalated" } };

    case "DECIDE": {
      // Automatic decisions only come from the verifier; escalated cases need a human.
      if (event.decidedBy === "auto" && (actor.role !== "system" || from !== "verifying")) {
        throw new TransitionError(
          "forbidden_actor",
          "auto decisions must come from the system while verifying",
        );
      }
      if (event.decidedBy === "human" && actor.role !== "ops") {
        throw new TransitionError("forbidden_actor", "human decisions must come from ops");
      }
      if (event.confidence !== null && (event.confidence < 0 || event.confidence > 1)) {
        throw new TransitionError("invalid_outcome", "confidence must be between 0 and 1");
      }
      assertOutcome(event.outcome);
      return {
        from,
        to: "decided",
        patch: { status: "decided", outcome: event.outcome, decidedAt: now },
      };
    }

    case "MISS_DEADLINE":
      if (!pastDeadline) {
        throw new TransitionError("deadline_not_passed", "delivery deadline has not passed yet");
      }
      return {
        from,
        to: "decided",
        patch: { status: "decided", outcome: { kind: "refund" }, decidedAt: now },
      };

    case "OPEN_DISPUTE": {
      if (s.disputeResolved) {
        throw new TransitionError(
          "dispute_already_resolved",
          "this agreement's dispute was already resolved; the decision is final",
        );
      }
      const ends = appealWindowEndsAt(s);
      if (!ends || now.getTime() >= ends.getTime()) {
        throw new TransitionError("appeal_window_closed", "the appeal window has closed");
      }
      // Each side can only dispute an outcome that went against them.
      const kind = s.outcome?.kind;
      const buyerLost = kind === "release" || kind === "partial";
      const sellerLost = kind === "refund" || kind === "partial";
      if ((actor.role === "buyer" && !buyerLost) || (actor.role === "seller" && !sellerLost)) {
        throw new TransitionError(
          "nothing_to_dispute",
          `the ${actor.role} cannot dispute a "${kind}" outcome`,
        );
      }
      return { from, to: "disputed", patch: { status: "disputed" } };
    }

    case "RESOLVE_DISPUTE":
      assertOutcome(event.outcome);
      return {
        from,
        to: "decided",
        patch: {
          status: "decided",
          outcome: event.outcome,
          decidedAt: now,
          disputeResolved: true,
        },
      };

    case "SETTLE": {
      // Money moves only once the decision is final, unless forced (e.g. a card hold about to expire).
      const ends = appealWindowEndsAt(s);
      const windowOpen = ends !== null && now.getTime() < ends.getTime();
      if (windowOpen && !s.disputeResolved && !event.force) {
        throw new TransitionError(
          "appeal_window_open",
          `cannot settle until the appeal window closes at ${ends?.toISOString()}`,
        );
      }
      return { from, to: "settled", patch: { status: "settled" } };
    }
  }
}

export function isTerminal(state: AgreementState): boolean {
  return TERMINAL_STATES.includes(state);
}
