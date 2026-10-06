import { describe, expect, it } from "vitest";
import {
  type Actor,
  type ActorRole,
  AGREEMENT_STATES,
  type AgreementEvent,
  type AgreementSnapshot,
  type AgreementState,
  type EventType,
  RULES,
  TransitionError,
  transition,
} from "../src/state-machine.ts";

const T0 = new Date("2026-10-06T12:00:00Z");
const DUE = new Date("2026-10-10T12:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function snap(over: Partial<AgreementSnapshot> = {}): AgreementSnapshot {
  return {
    status: "draft",
    specHash: "a".repeat(64),
    deliveryDueAt: DUE,
    appealWindowHours: 72,
    outcome: null,
    decidedAt: null,
    disputeResolved: false,
    ...over,
  };
}

const actor = (role: ActorRole): Actor => ({ role, ref: `${role}_1` });

/** One valid-looking example of every event, used for the exhaustive matrix. */
const SAMPLE: Record<EventType, AgreementEvent> = {
  APPROVE_SPEC: { type: "APPROVE_SPEC", specHash: "a".repeat(64) },
  CANCEL: { type: "CANCEL", reason: "changed mind" },
  FUND: { type: "FUND", rail: "test", holdRef: "hold_1" },
  DELIVER: { type: "DELIVER", deliveryId: "dlv_1", manifestHash: "b".repeat(64) },
  START_VERIFICATION: { type: "START_VERIFICATION" },
  ESCALATE: { type: "ESCALATE", reason: "low confidence" },
  DECIDE: {
    type: "DECIDE",
    outcome: { kind: "release" },
    decidedBy: "human",
    confidence: null,
    reason: "ok",
  },
  MISS_DEADLINE: { type: "MISS_DEADLINE" },
  OPEN_DISPUTE: { type: "OPEN_DISPUTE", reason: "wrong" },
  RESOLVE_DISPUTE: { type: "RESOLVE_DISPUTE", outcome: { kind: "refund" }, reason: "upheld" },
  SETTLE: { type: "SETTLE", settlementRef: "stl_1", force: true },
};

function errCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof TransitionError) return e.code;
    throw e;
  }
}

describe("state machine: exhaustive from-state matrix", () => {
  const cases = AGREEMENT_STATES.flatMap((state) =>
    (Object.keys(SAMPLE) as EventType[]).map((type) => [state, type] as const),
  );

  it.each(cases)("%s + %s", (state: AgreementState, type: EventType) => {
    const rule = RULES[type];
    const role = rule.actors[0] as ActorRole;
    const code = errCode(() => transition(snap({ status: state }), SAMPLE[type], actor(role), T0));
    if (rule.from.includes(state)) {
      expect(code).not.toBe("invalid_transition");
    } else {
      expect(code).toBe("invalid_transition");
    }
  });

  it("terminal states accept no events", () => {
    for (const state of ["settled", "cancelled"] as const) {
      for (const type of Object.keys(SAMPLE) as EventType[]) {
        const role = RULES[type].actors[0] as ActorRole;
        expect(
          errCode(() => transition(snap({ status: state }), SAMPLE[type], actor(role), T0)),
        ).toBe("invalid_transition");
      }
    }
  });
});

describe("state machine: actor permissions", () => {
  const roles: ActorRole[] = ["buyer", "seller", "ops", "system"];
  const cases = (Object.keys(RULES) as EventType[]).flatMap((type) =>
    roles.map((role) => [type, role] as const),
  );

  it.each(cases)("%s by %s", (type, role) => {
    const state = RULES[type].from[0] as AgreementState;
    // DECIDE's decidedBy must match the role (auto=system, human=ops); test the matching variant.
    const event =
      type === "DECIDE"
        ? ({ ...SAMPLE.DECIDE, decidedBy: role === "system" ? "auto" : "human" } as AgreementEvent)
        : SAMPLE[type];
    const code = errCode(() => transition(snap({ status: state }), event, actor(role), T0));
    if (!RULES[type].actors.includes(role)) expect(code).toBe("forbidden_actor");
    else expect(code).not.toBe("forbidden_actor");
  });
});

describe("state machine: guards", () => {
  it("happy path: draft → settled", () => {
    let s = snap();
    const step = (e: AgreementEvent, role: ActorRole, now: Date) => {
      const r = transition(s, e, actor(role), now);
      s = { ...s, ...r.patch };
      return r.to;
    };
    expect(step(SAMPLE.APPROVE_SPEC, "buyer", T0)).toBe("spec_approved");
    expect(step(SAMPLE.FUND, "buyer", T0)).toBe("funded");
    expect(step(SAMPLE.DELIVER, "seller", at(HOUR))).toBe("delivered");
    expect(step(SAMPLE.DELIVER, "seller", at(2 * HOUR))).toBe("delivered"); // redelivery
    expect(step(SAMPLE.START_VERIFICATION, "system", at(2 * HOUR))).toBe("verifying");
    expect(
      step(
        { ...SAMPLE.DECIDE, decidedBy: "auto", confidence: 0.97 } as AgreementEvent,
        "system",
        at(3 * HOUR),
      ),
    ).toBe("decided");
    expect(s.decidedAt).toEqual(at(3 * HOUR));
    expect(
      step({ ...SAMPLE.SETTLE, force: false } as AgreementEvent, "system", at(76 * HOUR)),
    ).toBe("settled");
  });

  it("approval requires the exact current spec hash", () => {
    expect(
      errCode(() =>
        transition(snap(), { type: "APPROVE_SPEC", specHash: "c".repeat(64) }, actor("buyer"), T0),
      ),
    ).toBe("spec_hash_mismatch");
  });

  it("can't fund or deliver after the deadline", () => {
    const late = at(DUE.getTime() - T0.getTime() + 1);
    expect(
      errCode(() =>
        transition(snap({ status: "spec_approved" }), SAMPLE.FUND, actor("buyer"), late),
      ),
    ).toBe("deadline_passed");
    expect(
      errCode(() => transition(snap({ status: "funded" }), SAMPLE.DELIVER, actor("seller"), late)),
    ).toBe("deadline_passed");
  });

  it("delivery exactly at the deadline is on time", () => {
    expect(transition(snap({ status: "funded" }), SAMPLE.DELIVER, actor("seller"), DUE).to).toBe(
      "delivered",
    );
  });

  it("missed deadline refunds, but only after the deadline", () => {
    const s = snap({ status: "funded" });
    expect(errCode(() => transition(s, SAMPLE.MISS_DEADLINE, actor("system"), T0))).toBe(
      "deadline_not_passed",
    );
    const r = transition(s, SAMPLE.MISS_DEADLINE, actor("system"), at(5 * 24 * HOUR));
    expect(r.to).toBe("decided");
    expect(r.patch.outcome).toEqual({ kind: "refund" });
  });

  it("auto decisions only come from the system while verifying", () => {
    const auto = { ...SAMPLE.DECIDE, decidedBy: "auto" } as AgreementEvent;
    expect(errCode(() => transition(snap({ status: "verifying" }), auto, actor("ops"), T0))).toBe(
      "forbidden_actor",
    );
    expect(
      errCode(() => transition(snap({ status: "escalated" }), auto, actor("system"), T0)),
    ).toBe("forbidden_actor");
    expect(transition(snap({ status: "verifying" }), auto, actor("system"), T0).to).toBe("decided");
  });

  it("human decisions only come from ops", () => {
    expect(
      errCode(() => transition(snap({ status: "escalated" }), SAMPLE.DECIDE, actor("system"), T0)),
    ).toBe("forbidden_actor");
    expect(transition(snap({ status: "escalated" }), SAMPLE.DECIDE, actor("ops"), T0).to).toBe(
      "decided",
    );
  });

  it.each([0, 100, 50.5, -1])("rejects partial release of %s%%", (pct) => {
    const e = {
      ...SAMPLE.DECIDE,
      outcome: { kind: "partial", releasePercent: pct },
    } as AgreementEvent;
    expect(errCode(() => transition(snap({ status: "escalated" }), e, actor("ops"), T0))).toBe(
      "invalid_outcome",
    );
  });

  it("rejects confidence outside 0..1", () => {
    const e = { ...SAMPLE.DECIDE, confidence: 1.5 } as AgreementEvent;
    expect(errCode(() => transition(snap({ status: "escalated" }), e, actor("ops"), T0))).toBe(
      "invalid_outcome",
    );
  });

  describe("disputes", () => {
    const decided = (kind: "release" | "refund" | "partial") =>
      snap({
        status: "decided",
        decidedAt: T0,
        outcome: kind === "partial" ? { kind, releasePercent: 40 } : { kind },
      });

    it.each([
      ["buyer", "release", true],
      ["buyer", "partial", true],
      ["buyer", "refund", false],
      ["seller", "refund", true],
      ["seller", "partial", true],
      ["seller", "release", false],
    ] as const)("%s disputing %s → allowed=%s", (role, kind, allowed) => {
      const code = errCode(() =>
        transition(decided(kind), SAMPLE.OPEN_DISPUTE, actor(role), at(HOUR)),
      );
      expect(code).toBe(allowed ? null : "nothing_to_dispute");
    });

    it("closes exactly when the appeal window ends", () => {
      expect(
        transition(decided("release"), SAMPLE.OPEN_DISPUTE, actor("buyer"), at(72 * HOUR - 1)).to,
      ).toBe("disputed");
      expect(
        errCode(() =>
          transition(decided("release"), SAMPLE.OPEN_DISPUTE, actor("buyer"), at(72 * HOUR)),
        ),
      ).toBe("appeal_window_closed");
    });

    it("a resolved dispute is final", () => {
      const r = transition(
        snap({ status: "disputed", decidedAt: T0 }),
        SAMPLE.RESOLVE_DISPUTE,
        actor("ops"),
        at(HOUR),
      );
      expect(r.patch).toMatchObject({
        status: "decided",
        disputeResolved: true,
        outcome: { kind: "refund" },
      });
      const after = snap({
        ...r.patch,
        status: "decided",
        decidedAt: at(HOUR),
        disputeResolved: true,
      });
      expect(
        errCode(() => transition(after, SAMPLE.OPEN_DISPUTE, actor("seller"), at(2 * HOUR))),
      ).toBe("dispute_already_resolved");
    });
  });

  describe("settlement", () => {
    const decided = snap({ status: "decided", decidedAt: T0, outcome: { kind: "release" } });
    const settle = (force: boolean): AgreementEvent => ({
      type: "SETTLE",
      settlementRef: "s",
      force,
    });

    it("waits for the appeal window", () => {
      expect(errCode(() => transition(decided, settle(false), actor("system"), at(HOUR)))).toBe(
        "appeal_window_open",
      );
      expect(transition(decided, settle(false), actor("system"), at(72 * HOUR)).to).toBe("settled");
    });

    it("can be forced early (e.g. card hold about to expire)", () => {
      expect(transition(decided, settle(true), actor("system"), at(HOUR)).to).toBe("settled");
    });

    it("settles immediately after a resolved dispute", () => {
      expect(
        transition({ ...decided, disputeResolved: true }, settle(false), actor("system"), at(HOUR))
          .to,
      ).toBe("settled");
    });

    it("settles immediately with a zero-hour appeal window", () => {
      expect(
        transition({ ...decided, appealWindowHours: 0 }, settle(false), actor("system"), T0).to,
      ).toBe("settled");
    });
  });
});
