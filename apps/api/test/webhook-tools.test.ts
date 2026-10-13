/** Webhook tools: test-send, replay after an outage, and the events list for backfill/polling. */
import { schema } from "@proofdesk/db";
import { verifyWebhook } from "@proofdesk/sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function receiver() {
  // biome-ignore lint/suspicious/noExplicitAny: bodies are asserted field by field
  const received: { body: any; raw: string; signature: string }[] = [];
  const state = { status: 200 };
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    received.push({
      raw: String(init?.body),
      body: JSON.parse(String(init?.body)),
      signature: new Headers(init?.headers).get("Proofdesk-Signature") ?? "",
    });
    return new Response("ok", { status: state.status });
  }) as typeof fetch;
  return { received, state, fetchFn };
}

const tick = () => h.call(h.keys.ops, "POST", "/v1/ops/run-due");
const newAgreement = (key = h.keys.platformA) =>
  h.call(key, "POST", "/v1/agreements", { buyer_ref: "b", seller_ref: "s", spec: specFixture() });

describe("webhook tools", () => {
  it("sends a signed test event on demand and reports the receiver's answer", async () => {
    const rx = receiver();
    h = await createHarness({ fetch: rx.fetchFn });
    const ep = (
      await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
        url: "https://platform.example/hooks",
      })
    ).body;
    const ok = (await h.call(h.keys.platformA, "POST", `/v1/webhook-endpoints/${ep.id}/test`)).body;
    expect(ok).toMatchObject({ ok: true, status_code: 200, error: null });
    const event = await verifyWebhook(
      rx.received[0]?.raw as string,
      rx.received[0]?.signature as string,
      ep.secret,
      { now: h.clock.now },
    );
    expect(event).toMatchObject({ type: "webhook.test", agreement_id: null });

    rx.state.status = 500;
    const bad = (await h.call(h.keys.platformA, "POST", `/v1/webhook-endpoints/${ep.id}/test`))
      .body;
    expect(bad).toMatchObject({ ok: false, status_code: 500, error: "HTTP 500" });
    expect(
      (await h.call(h.keys.platformB, "POST", `/v1/webhook-endpoints/${ep.id}/test`)).status,
    ).toBe(404);
  });

  it("replays events from a point and re-enables a disabled endpoint", async () => {
    const rx = receiver();
    h = await createHarness({ fetch: rx.fetchFn });
    const ep = (
      await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
        url: "https://platform.example/hooks",
      })
    ).body;
    await newAgreement();
    await newAgreement();
    await tick();
    const first = rx.received.map((r) => r.body.id);
    expect(first).toHaveLength(2);

    // The receiver lost its data and the endpoint got disabled meanwhile.
    await h.handle.db
      .update(schema.webhookEndpoints)
      .set({ enabled: false, failureCount: 20 })
      .where(eq(schema.webhookEndpoints.id, ep.id));
    const replayed = await h.call(
      h.keys.platformA,
      "POST",
      `/v1/webhook-endpoints/${ep.id}/replay`,
      {
        from_event: first[0],
      },
    );
    expect(replayed.body).toMatchObject({ enabled: true });
    await tick();
    expect(rx.received.map((r) => r.body.id)).toEqual([...first, ...first]);
    expect(
      (
        await h.call(h.keys.platformB, "POST", `/v1/webhook-endpoints/${ep.id}/replay`, {
          from_event: 1,
        })
      ).status,
    ).toBe(404);
  });

  it("lists this account's events with paging and a type filter", async () => {
    h = await createHarness();
    const agr = (await newAgreement()).body;
    await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    await newAgreement(h.keys.platformB);
    const all = (await h.call(h.keys.platformA, "GET", "/v1/events")).body;
    expect(all.data.map((e: { type: string }) => e.type)).toEqual([
      "agreement.created",
      "agreement.approve_spec",
    ]);
    expect(all.data.every((e: { agreement_id: string }) => e.agreement_id === agr.id)).toBe(true);
    const page = (await h.call(h.keys.platformA, "GET", "/v1/events?limit=1")).body;
    expect(page.data).toHaveLength(1);
    const next = (await h.call(h.keys.platformA, "GET", `/v1/events?after=${page.next_after}`))
      .body;
    expect(next.data.map((e: { type: string }) => e.type)).toEqual(["agreement.approve_spec"]);
    // Full type names include underscores, which must match literally (not as LIKE wildcards).
    for (const type of ["agreement.approve", "agreement.approve_spec"]) {
      const filtered = (await h.call(h.keys.platformA, "GET", `/v1/events?type=${type}`)).body;
      expect(filtered.data.map((e: { type: string }) => e.type)).toEqual([
        "agreement.approve_spec",
      ]);
    }
    const wildcard = (await h.call(h.keys.platformA, "GET", "/v1/events?type=agreement_")).body;
    expect(wildcard.data).toEqual([]);
  });
});
