import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { backoffMs } from "../src/services/webhooks.ts";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
  // Tests that don't create a harness mustn't close the previous test's one again.
  h = undefined as unknown as Harness;
});

/** A webhook receiver: records requests, answers with `status`. */
function receiver() {
  // biome-ignore lint/suspicious/noExplicitAny: event bodies are asserted field by field
  const received: { url: string; body: any; signature: string }[] = [];
  const state = { status: 200 };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    received.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      signature: new Headers(init?.headers).get("Proofdesk-Signature") ?? "",
    });
    return new Response("ok", { status: state.status });
  }) as typeof fetch;
  return { received, state, fetchFn };
}

const verifySignature = (secret: string, body: unknown, header: string) => {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const mac = createHmac("sha256", secret)
    .update(`${parts.t}.${JSON.stringify(body)}`)
    .digest("hex");
  return mac === parts.v1;
};

const tick = () => h.call(h.keys.ops, "POST", "/v1/ops/run-due");

async function newAgreement(key = h.keys.platformA) {
  return (
    await h.call(key, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    })
  ).body;
}

describe("outbound webhooks", () => {
  it("delivers this account's new events in ledger order, signed, from creation onward", async () => {
    const rx = receiver();
    h = await createHarness({ fetch: rx.fetchFn });
    await newAgreement(); // before the endpoint exists: not delivered
    const ep = await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
      url: "https://platform.example/hooks",
    });
    expect(ep.status).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_pd_/);

    const agr = await newAgreement();
    await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    await newAgreement(h.keys.platformB); // another account's event

    const result = (await tick()).body;
    expect(result.webhooks).toEqual({ delivered: 2, failed: [] });
    expect(rx.received.map((r) => r.body.type)).toEqual([
      "agreement.created",
      "agreement.approve_spec",
    ]);
    const [first] = rx.received;
    expect(first?.body).toMatchObject({
      object: "event",
      agreement_id: agr.id,
      id: expect.stringMatching(/^evt_\d+$/),
    });
    expect(verifySignature(ep.body.secret, first?.body, first?.signature ?? "")).toBe(true);

    expect((await tick()).body.webhooks.delivered).toBe(0); // nothing new
    const list = await h.call(h.keys.platformA, "GET", "/v1/webhook-endpoints");
    expect(list.body.data[0]).not.toHaveProperty("secret");
  });

  it("filters by event type prefix", async () => {
    const rx = receiver();
    h = await createHarness({ fetch: rx.fetchFn });
    await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
      url: "https://platform.example/hooks",
      event_types: ["agreement.approve"],
    });
    const agr = await newAgreement();
    await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    await tick();
    expect(rx.received.map((r) => r.body.type)).toEqual(["agreement.approve_spec"]);
  });

  it("retries a failing endpoint with backoff and redelivers the same event", async () => {
    const rx = receiver();
    h = await createHarness({ fetch: rx.fetchFn });
    const ep = (
      await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
        url: "https://platform.example/hooks",
      })
    ).body;
    await newAgreement();
    rx.state.status = 500;
    expect((await tick()).body.webhooks).toEqual({ delivered: 0, failed: [ep.id] });
    const failing = (await h.call(h.keys.platformA, "GET", "/v1/webhook-endpoints")).body.data[0];
    expect(failing).toMatchObject({ failure_count: 1, last_error: "HTTP 500", enabled: true });

    await tick(); // still backing off: not attempted
    expect(rx.received).toHaveLength(1);

    rx.state.status = 200;
    h.clock.advance(backoffMs(1));
    expect((await tick()).body.webhooks.delivered).toBe(1);
    expect(rx.received[1]?.body.id).toBe(rx.received[0]?.body.id);

    const attempts = await h.call(
      h.keys.platformA,
      "GET",
      `/v1/webhook-endpoints/${ep.id}/attempts`,
    );
    expect(attempts.body.data.map((a: { status_code: number }) => a.status_code).sort()).toEqual([
      200, 500,
    ]);
  });

  it("requires https (except localhost) and scopes endpoints to their account", async () => {
    h = await createHarness();
    const insecure = await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
      url: "http://platform.example/x",
    });
    expect(insecure.body.error.code).toBe("insecure_url");
    const local = await h.call(h.keys.platformA, "POST", "/v1/webhook-endpoints", {
      url: "http://localhost:3000/x",
    });
    expect(local.status).toBe(201);
    expect(
      (await h.call(h.keys.platformB, "DELETE", `/v1/webhook-endpoints/${local.body.id}`)).status,
    ).toBe(404);
    expect(
      (await h.call(h.keys.platformA, "DELETE", `/v1/webhook-endpoints/${local.body.id}`)).body,
    ).toEqual({ deleted: true });
  });

  it("backs off exponentially up to 6 hours", () => {
    expect([1, 2, 3, 10, 30].map(backoffMs)).toEqual([
      60_000,
      120_000,
      240_000,
      6 * 3_600_000,
      6 * 3_600_000,
    ]);
  });
});

describe("sandbox test helpers", () => {
  it("lets a test-mode platform run the whole lifecycle without ops", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const agr = await newAgreement();
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
    h.clock.advance(HOUR);
    await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
      artifacts: [{ name: "x.txt", media_type: "text/plain", content: "done" }],
    });
    const decided = await h.call(A, "POST", `/v1/test_helpers/agreements/${agr.id}/decide`, {
      outcome: { kind: "release" },
    });
    expect(decided.body).toMatchObject({ status: "decided", outcome: { kind: "release" } });
    const settled = await h.call(A, "POST", `/v1/test_helpers/agreements/${agr.id}/settle`);
    expect(settled.body).toMatchObject({ status: "settled", settlement_ref: `sandbox:${agr.id}` });
  });

  it("refuses live keys and other accounts' agreements", async () => {
    h = await createHarness();
    const live = await h.call(h.keys.live, "POST", "/v1/test_helpers/agreements/agr_x/settle");
    expect(live.status).toBe(403);
    const agr = await newAgreement();
    const other = await h.call(
      h.keys.platformB,
      "POST",
      `/v1/test_helpers/agreements/${agr.id}/settle`,
    );
    expect(other.status).toBe(404);
  });
});
