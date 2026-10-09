/**
 * Proof Desk's prices (MASTER_PLAN §3, v1, to validate with design partners). All in USD cents.
 * The conditional payment fee is taken inside each settlement; verification and dispute fees
 * are invoiced to the platform monthly.
 */
export const PRICING = {
  /** % of the released amount, kept at settlement. */
  conditionalPayment: { rate: 0.02, minCents: 50, capCents: 25_000 },
  /** Per automated verification run, by vertical. */
  verification: {
    translation: 150, // standard: domain checks + judge ensemble
    code: 300, // deep: sandboxed test run (+ judge)
    data: 50, // basic: schema/count/uniqueness (+ judge)
    research: 150, // standard: citations and quotes fetched and checked (+ judge)
  },
  /** Human dispute resolution: the higher of a flat fee or a share of the amount. */
  dispute: { minCents: 2_500, rate: 0.05 },
  /** Verify-only plan (no money movement): monthly minimum on verification fees. */
  verifyOnlyMonthlyMinimumCents: 9_900,
  /** What Proof Desk pays its human reviewers. */
  reviewer: { decisionCents: 800, disputeResolutionCents: 2_000 },
  /**
   * Largest live amount held directly (card hold or on-chain job). Bigger B2B jobs go through a
   * licensed escrow partner (MASTER_PLAN §1); until one is integrated they can't be funded live.
   * Change only with legal sign-off.
   */
  directHoldMaxCents: 500_000,
} as const;

/**
 * An agreement amount in USD cents, for fees priced in USD. Stablecoins convert at par; other
 * currencies are taken at face value in their own minor units (approximate; flagged in the
 * invoice line).
 */
export function usdCents(value: number, currency: string): { cents: number; exact: boolean } {
  const c = currency.toLowerCase();
  if (c === "usd") return { cents: value, exact: true };
  if (c === "usdc" || c === "usdt") return { cents: Math.round(value / 10_000), exact: true };
  return { cents: value, exact: false };
}

export function disputeFeeCents(value: number, currency: string): number {
  const { cents } = usdCents(value, currency);
  return Math.max(PRICING.dispute.minCents, Math.round(cents * PRICING.dispute.rate));
}

/** "2026-10" for a date (UTC). */
export function billingPeriod(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** [start, end) of a "YYYY-MM" period, UTC. */
export function periodRange(period: string): [Date, Date] {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`invalid period ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return [new Date(Date.UTC(y, mo, 1)), new Date(Date.UTC(y, mo + 1, 1))];
}
