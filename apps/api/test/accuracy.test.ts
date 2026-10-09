/** Part 10: the public accuracy report (production stats, live only, aggregates only). */
import { newId } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function decided(
  key: string,
  vertical: string,
  p: {
    action: "decide" | "escalate";
    dispute?: "upheld" | "overturned";
    review?: "confirmed" | "overridden";
  },
) {
  const agr = (
    await h.call(key, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture({ vertical }),
    })
  ).body;
  const db = h.handle.db;
  const at = h.clock.now;
  const deliveryId = newId("delivery");
  await db.insert(schema.deliveries).values({
    id: deliveryId,
    agreementId: agr.id,
    artifacts: [],
    manifestHash: "0".repeat(64),
    submittedAt: at,
  });
  await db.insert(schema.verifications).values({
    id: newId("verification"),
    agreementId: agr.id,
    deliveryId,
    engineVersion: "test",
    report: {},
    reportHash: "0".repeat(64),
    action: p.action,
    outcome: p.action === "decide" ? { kind: "release" } : null,
    confidence: 0.9,
    costUsd: 0,
    createdAt: at,
  });
  if (p.action !== "decide") return;
  const autoId = newId("decision");
  await db.insert(schema.decisions).values({
    id: autoId,
    agreementId: agr.id,
    kind: "verification",
    outcome: { kind: "release" },
    decidedBy: "auto",
    actorRef: "verifier",
    confidence: 0.9,
    reason: "passed",
    createdAt: at,
  });
  if (p.review) {
    const overrideId = p.review === "overridden" ? newId("decision") : null;
    if (overrideId) {
      await db.insert(schema.decisions).values({
        id: overrideId,
        agreementId: agr.id,
        kind: "review_override",
        outcome: { kind: "refund" },
        decidedBy: "human",
        actorRef: "key_ops",
        confidence: null,
        reason: "reviewed",
        createdAt: new Date(at.getTime() + 500),
      });
    }
    await db.insert(schema.decisionReviews).values({
      id: newId("review"),
      agreementId: agr.id,
      decisionId: autoId,
      autoOutcome: { kind: "release" },
      reviewedOutcome: overrideId ? { kind: "refund" } : { kind: "release" },
      agreed: !overrideId,
      overrideDecisionId: overrideId,
      reviewerRef: "key_ops",
      reason: "reviewed",
      createdAt: new Date(at.getTime() + 500),
    });
  }
  if (!p.dispute) return;
  await db.insert(schema.decisions).values({
    id: newId("decision"),
    agreementId: agr.id,
    kind: "dispute_resolution",
    outcome: p.dispute === "overturned" ? { kind: "refund" } : { kind: "release" },
    decidedBy: "human",
    actorRef: "key_ops",
    confidence: null,
    reason: "reviewed",
    createdAt: new Date(at.getTime() + 1000),
  });
}

describe("accuracy report", () => {
  it("publishes live rates per verifier once there's enough data, and counts overturns", async () => {
    h = await createHarness();
    const live = h.keys.live;
    for (let i = 0; i < 22; i++) await decided(live, "code", { action: "decide" });
    await decided(live, "code", { action: "decide", dispute: "upheld" });
    await decided(live, "code", { action: "decide", dispute: "overturned" });
    await decided(live, "code", { action: "decide", dispute: "overturned" });
    for (let i = 0; i < 5; i++) await decided(live, "code", { action: "escalate" });
    for (let i = 0; i < 3; i++) await decided(live, "data", { action: "decide" });
    // Test mode never counts.
    for (let i = 0; i < 5; i++)
      await decided(h.keys.platformA, "code", { action: "decide", dispute: "overturned" });

    const report = (await h.call(null, "GET", "/accuracy.json")).body;
    const code = report.verticals.find((v: { vertical: string }) => v.vertical === "code");
    expect(code).toMatchObject({
      verifications: 30,
      auto_decisions: 25,
      escalated: 5,
      disputed: 3,
      overturned: 2,
      published: true,
    });
    expect(code.overturn_rate).toBeCloseTo(0.08);
    expect(code.escalation_rate).toBeCloseTo(5 / 30);
    const data = report.verticals.find((v: { vertical: string }) => v.vertical === "data");
    expect(data).toMatchObject({ auto_decisions: 3, published: false, overturn_rate: null });

    const html = await (await h.fetch("http://x/accuracy")).text();
    expect(html).toContain("8.0%");
    expect(html).toContain("not enough data");
    expect(html).not.toMatch(/agr_|acct_/);
  });

  it("publishes the labelled test-set results (accuracy v0) before any live data", async () => {
    h = await createHarness();
    const report = (await h.call(null, "GET", "/accuracy.json")).body;
    const code = report.golden_sets.suites.find((s: { suite: string }) => s.suite === "code");
    expect(code.status).toBe("measured");
    expect(code.runs[0]).toMatchObject({ items_run: 130, model_layers: false, pass: true });
    const translation = report.golden_sets.suites.find(
      (s: { suite: string }) => s.suite === "translation",
    );
    expect(translation.status).toBe("pending");
    const html = await (await h.fetch("http://x/accuracy")).text();
    expect(html).toContain("Before release: labelled test sets");
    expect(html).toContain("130 labelled items");
    expect(html).toContain("hasn&#39;t been measured yet");
  });

  it("counts shadow reviews, and overrides as overturns (the last human word wins)", async () => {
    h = await createHarness();
    const live = h.keys.live;
    await decided(live, "data", { action: "decide", review: "confirmed" });
    await decided(live, "data", { action: "decide", review: "overridden" });
    // Overridden on review, then restored on dispute: the automatic decision stood.
    await decided(live, "data", { action: "decide", review: "overridden", dispute: "upheld" });
    await decided(live, "data", { action: "decide" });
    const report = (await h.call(null, "GET", "/accuracy.json")).body;
    expect(report.verticals).toEqual([
      expect.objectContaining({
        vertical: "data",
        auto_decisions: 4,
        reviewed: 3,
        disputed: 1,
        overturned: 1,
      }),
    ]);
  });
});
