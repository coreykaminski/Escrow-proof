import type { HoldState } from "./gateway.ts";

/** Conditional payment fee: 2% of the released amount, min 50, cap 25,000 minor units. */
export const FEE = { rate: 0.02, min: 50, cap: 25_000 } as const;

export function platformFee(released: number): number {
  if (released <= 0) return 0;
  const fee = Math.round(released * FEE.rate);
  return Math.min(released, Math.min(FEE.cap, Math.max(FEE.min, fee)));
}

export type SettlementOutcome =
  | { kind: "release" }
  | { kind: "refund" }
  | { kind: "partial"; releasePercent: number };

/** One money movement. Each has a stable key so a retried settlement can't repeat it. */
export type SettlementStep =
  | { op: "capture"; amount: number; key: string }
  | { op: "cancel"; key: string }
  | { op: "refund"; amount: number; key: string }
  | { op: "transfer"; amount: number; key: string };

export interface SettlementPlan {
  /** What the seller is owed before the fee. */
  release: number;
  fee: number;
  /** What the seller actually receives. */
  sellerPayout: number;
  /** What goes back to the buyer (by cancel or refund). */
  buyerRefund: number;
  steps: SettlementStep[];
}

/**
 * Turns a final outcome into money movements against the hold's current state:
 * - still authorized: capture only what's released (the rest of the authorization lapses at no
 *   cost); cancel outright for a full refund;
 * - already captured (early, before the authorization expired): refund the buyer's share.
 * Then transfer the seller's share minus the fee to their connected account. Planning from the
 * hold's live state makes a retried settlement pick up where a failed one stopped.
 */
export function planSettlement(
  agreementId: string,
  hold: Pick<HoldState, "status" | "amount" | "amount_capturable" | "amount_received">,
  outcome: SettlementOutcome,
): SettlementPlan {
  const total = hold.amount;
  const release =
    outcome.kind === "release"
      ? total
      : outcome.kind === "refund"
        ? 0
        : Math.round((total * outcome.releasePercent) / 100);
  const fee = platformFee(release);
  const key = (step: string) => `settle:${agreementId}:${step}`;
  const steps: SettlementStep[] = [];

  if (hold.amount_received > 0) {
    // Captured already (early, or by an earlier attempt of this settlement): give back whatever
    // was captured beyond the seller's share. A partial capture leaves nothing to refund.
    if (hold.amount_received < release) {
      throw new SettlementError("captured less than the amount to release");
    }
    const excess = hold.amount_received - release;
    if (excess > 0) steps.push({ op: "refund", amount: excess, key: key("refund") });
  } else if (hold.status === "canceled") {
    // The authorization is gone; that only settles cleanly if nothing is owed to the seller.
    if (release > 0) throw new SettlementError("the card authorization lapsed before capture");
  } else if (release === 0) {
    steps.push({ op: "cancel", key: key("cancel") });
  } else {
    steps.push({ op: "capture", amount: release, key: key("capture") });
  }
  const sellerPayout = release - fee;
  if (sellerPayout > 0) steps.push({ op: "transfer", amount: sellerPayout, key: key("transfer") });

  return { release, fee, sellerPayout, buyerRefund: total - release, steps };
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Standard card authorizations last about 7 days; extended ones about 30. */
export const AUTH_WINDOW_DAYS = { standard: 7, extended: 30 } as const;

/**
 * Whether to ask for an extended authorization: the hold has to last through the delivery
 * deadline, a day for verification, and the appeal window.
 */
export function needsExtendedAuthorization(
  now: Date,
  deliveryDueAt: Date,
  appealWindowHours: number,
): boolean {
  const neededMs =
    deliveryDueAt.getTime() - now.getTime() + 24 * 3_600_000 + appealWindowHours * 3_600_000;
  return neededMs > (AUTH_WINDOW_DAYS.standard - 1) * 24 * 3_600_000;
}
