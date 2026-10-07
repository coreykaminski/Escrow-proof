import { ProofDesk, ProofDeskError, verifyWebhook, WebhookVerificationError } from "@proofdesk/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const sdk = (fetchFn = h.fetch, apiKey = h.keys.platformA) =>
  new ProofDesk({ apiKey, baseUrl: "http://proofdesk.test", fetch: fetchFn });

describe("@proofdesk/sdk", () => {
  it("runs the sandbox lifecycle end to end", async () => {
    h = await createHarness();
    const pd = sdk();
    const agr = await pd.agreements.create({
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture() as never,
    });
    expect(agr.status).toBe("draft");
    await pd.agreements.approveSpec(agr.id, agr.spec_hash);
    await pd.agreements.fund(agr.id, { rail: "test", hold_ref: "h1" });
    h.clock.advance(HOUR);
    const d = await pd.agreements.deliver(agr.id, [
      { name: "x.txt", media_type: "text/plain", content: "done" },
    ]);
    expect(d.agreement.status).toBe("delivered");
    await pd.testHelpers.decide(agr.id, { kind: "release" });
    const settled = await pd.testHelpers.settle(agr.id);
    expect(settled.status).toBe("settled");
    const ledger = await pd.agreements.ledger(agr.id);
    expect(ledger.data.at(-1)?.type).toBe("agreement.settle");
    expect((await pd.agreements.list({ status: "settled" })).data.map((a) => a.id)).toEqual([
      agr.id,
    ]);
  });

  it("throws typed errors", async () => {
    h = await createHarness();
    const err = await sdk()
      .agreements.retrieve("agr_missing")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofDeskError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
    expect(() => new ProofDesk({ apiKey: "sk_wrong" })).toThrow(/pd_test_/);
  });

  it("retries a failed request with the same idempotency key, so it acts once", async () => {
    h = await createHarness();
    const keys: string[] = [];
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      const res = await h.fetch(input, init);
      // The first attempt reaches the server, but its response is "lost".
      return ++calls === 1 ? new Response("upstream timeout", { status: 502 }) : res;
    }) as typeof fetch;
    const agr = await sdk(flaky).agreements.create({
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture() as never,
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const all = await sdk().agreements.list();
    expect(all.data.map((a) => a.id)).toEqual([agr.id]);
  });

  it("verifies real webhook deliveries and rejects tampering and replays", async () => {
    let captured: { body: string; signature: string } | undefined;
    const receiver = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = {
        body: String(init?.body),
        signature: new Headers(init?.headers).get("Proofdesk-Signature") ?? "",
      };
      return new Response("ok");
    }) as typeof fetch;
    h = await createHarness({ fetch: receiver });
    const pd = sdk();
    const endpoint = await pd.webhookEndpoints.create({ url: "https://platform.example/hooks" });
    await pd.agreements.create({ buyer_ref: "b", seller_ref: "s", spec: specFixture() as never });
    await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
    if (!captured || !endpoint.secret) throw new Error("no delivery");

    const at = h.clock.now;
    const event = await verifyWebhook(captured.body, captured.signature, endpoint.secret, {
      now: at,
    });
    expect(event).toMatchObject({ object: "event", type: "agreement.created" });

    await expect(
      verifyWebhook(
        captured.body.replace("agreement.created", "agreement.settle"),
        captured.signature,
        endpoint.secret,
        { now: at },
      ),
    ).rejects.toThrow(WebhookVerificationError);
    await expect(
      verifyWebhook(captured.body, captured.signature, endpoint.secret, {
        now: new Date(at.getTime() + 10 * 60_000),
      }),
    ).rejects.toThrow(/tolerance/);
    await expect(
      verifyWebhook(captured.body, captured.signature, "whsec_pd_wrong", { now: at }),
    ).rejects.toThrow(/doesn't match/);
  });
});
