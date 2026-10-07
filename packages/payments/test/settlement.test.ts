import { describe, expect, it } from "vitest";
import {
  needsExtendedAuthorization,
  planSettlement,
  platformFee,
  SettlementError,
} from "../src/settlement.ts";

const authorized = {
  status: "requires_capture" as const,
  amount: 18_000,
  amount_capturable: 18_000,
  amount_received: 0,
};
const captured = {
  status: "succeeded" as const,
  amount: 18_000,
  amount_capturable: 0,
  amount_received: 18_000,
};

describe("platformFee", () => {
  it.each([
    [18_000, 360],
    [1_000, 50],
    [10, 10],
    [5_000_000, 25_000],
    [0, 0],
  ])("%i → %i", (amount, fee) => {
    expect(platformFee(amount)).toBe(fee);
  });
});

describe("planSettlement", () => {
  it("release on an authorized hold: capture all, transfer all but the fee", () => {
    expect(planSettlement("agr_1", authorized, { kind: "release" })).toEqual({
      release: 18_000,
      fee: 360,
      sellerPayout: 17_640,
      buyerRefund: 0,
      steps: [
        { op: "capture", amount: 18_000, key: "settle:agr_1:capture" },
        { op: "transfer", amount: 17_640, key: "settle:agr_1:transfer" },
      ],
    });
  });

  it("refund on an authorized hold: cancel, nothing captured, no fee", () => {
    expect(planSettlement("agr_1", authorized, { kind: "refund" })).toMatchObject({
      fee: 0,
      sellerPayout: 0,
      buyerRefund: 18_000,
      steps: [{ op: "cancel", key: "settle:agr_1:cancel" }],
    });
  });

  it("partial on an authorized hold: capture only the released share", () => {
    expect(
      planSettlement("agr_1", authorized, { kind: "partial", releasePercent: 25 }),
    ).toMatchObject({
      release: 4_500,
      fee: 90,
      buyerRefund: 13_500,
      steps: [
        { op: "capture", amount: 4_500 },
        { op: "transfer", amount: 4_410 },
      ],
    });
  });

  it("on an already-captured hold, refunds the buyer's share instead", () => {
    expect(planSettlement("agr_1", captured, { kind: "refund" }).steps).toEqual([
      { op: "refund", amount: 18_000, key: "settle:agr_1:refund" },
    ]);
    expect(
      planSettlement("agr_1", captured, { kind: "partial", releasePercent: 50 }).steps,
    ).toEqual([
      { op: "refund", amount: 9_000, key: "settle:agr_1:refund" },
      { op: "transfer", amount: 8_820, key: "settle:agr_1:transfer" },
    ]);
    expect(planSettlement("agr_1", captured, { kind: "release" }).steps.map((s) => s.op)).toEqual([
      "transfer",
    ]);
  });
});

describe("planSettlement on retry", () => {
  it("after a partial capture succeeded, only the transfer remains", () => {
    const partlyDone = {
      status: "succeeded" as const,
      amount: 18_000,
      amount_capturable: 0,
      amount_received: 4_500,
    };
    expect(
      planSettlement("agr_1", partlyDone, { kind: "partial", releasePercent: 25 }).steps,
    ).toEqual([{ op: "transfer", amount: 4_410, key: "settle:agr_1:transfer" }]);
  });

  it("after a cancel succeeded, nothing remains", () => {
    const canceled = {
      status: "canceled" as const,
      amount: 18_000,
      amount_capturable: 0,
      amount_received: 0,
    };
    expect(planSettlement("agr_1", canceled, { kind: "refund" }).steps).toEqual([]);
  });

  it("refuses to release from a lapsed authorization", () => {
    const lapsed = {
      status: "canceled" as const,
      amount: 18_000,
      amount_capturable: 0,
      amount_received: 0,
    };
    expect(() => planSettlement("agr_1", lapsed, { kind: "release" })).toThrow(SettlementError);
  });
});

describe("needsExtendedAuthorization", () => {
  const now = new Date("2026-10-07T00:00:00Z");
  it("isn't needed when delivery + verification + appeal fit in the standard window", () => {
    expect(needsExtendedAuthorization(now, new Date("2026-10-09T00:00:00Z"), 72)).toBe(false);
  });
  it("is needed for longer jobs", () => {
    expect(needsExtendedAuthorization(now, new Date("2026-10-12T00:00:00Z"), 72)).toBe(true);
  });
});
