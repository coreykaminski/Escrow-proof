/** Request ids, structured logs (no secrets), ops metrics and alerts. */
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { Alerter, createLogger } from "../src/observability.ts";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l)) }),
  };
}

describe("observability", () => {
  it("gives every response a request id, keeps a well-formed incoming one, and puts it in errors", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "GET", "/v1/agreements");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await h.call(h.keys.platformA, "GET", "/v1/agreements", undefined, {
      "X-Request-Id": "fly-abc12345",
    });
    expect(kept.headers.get("x-request-id")).toBe("fly-abc12345");
    const bad = await h.call(h.keys.platformA, "GET", "/v1/agreements", undefined, {
      "X-Request-Id": "<script>",
    });
    expect(bad.headers.get("x-request-id")).not.toBe("<script>");
    const err = await h.call(h.keys.platformA, "GET", "/v1/agreements/agr_missing");
    expect(err.body.error.request_id).toBe(err.headers.get("x-request-id"));
  });

  it("logs one line per request by route pattern, never the path's secrets", async () => {
    const { lines, logger } = capture();
    h = await createHarness({ logger });
    const agr = (
      await h.call(h.keys.platformA, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture(),
      })
    ).body;
    const link = (
      await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/report-links`, {})
    ).body;
    const token = link.url.split("/r/")[1];
    await h.fetch(link.url);
    const requests = lines.filter((l) => l.msg === "request");
    expect(requests.map((l) => l.route)).toEqual([
      "/v1/agreements",
      "/v1/agreements/:id/report-links",
      "/r/:token",
    ]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      status: 201,
      account: expect.stringMatching(/^acct_/),
    });
    expect(typeof requests[0]?.ms).toBe("number");
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it("serves ops metrics: requests, verification volume, latency and cost", async () => {
    h = await createHarness({
      codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
    });
    await h.call(h.keys.platformA, "POST", "/v1/verifications", {
      template: { id: "code.acceptance-tests", params: { task: "Write f()." } },
      inputs: [
        {
          name: "t/a.test.mjs",
          media_type: "text/javascript",
          content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[public-tests] f", () => { if (f() !== 1) throw new Error("no"); });\n`,
        },
      ],
      deliverable: [
        { name: "f.mjs", media_type: "text/javascript", content: "export const f = () => 1;" },
      ],
    });
    await h.call(h.keys.platformA, "GET", "/v1/agreements/agr_nope");
    const m = (await h.call(h.keys.ops, "GET", "/v1/ops/metrics")).body;
    expect(m.requests.requests).toBeGreaterThanOrEqual(2);
    expect(m.requests.by_status["4xx"]).toBeGreaterThanOrEqual(1);
    expect(m.verifications.verticals).toEqual([
      expect.objectContaining({
        vertical: "code",
        checks: 1,
        escalated: 0,
        cost_usd: { total: 0, per_check: 0 },
      }),
    ]);
    expect(m.verifications.verticals[0].latency_ms.p50).toBeGreaterThan(0);
    expect((await h.call(h.keys.platformA, "GET", "/v1/ops/metrics")).status).toBe(403);
  });

  it("alerts once per quiet window on server errors, and never throws", async () => {
    const posts: unknown[] = [];
    const alerter = new Alerter("https://hooks.example/alert", {
      fetch: (async (_url: string, init: RequestInit) => {
        posts.push(JSON.parse(String(init.body)));
        return new Response("ok");
      }) as typeof fetch,
    });
    const { lines, logger } = capture();
    h = await createHarness({
      logger,
      alerter,
      codeVerifier: async () => {
        throw new Error("unexpected verifier bug");
      },
    });
    const job = {
      template: { id: "code.acceptance-tests", params: { task: "Write f()." } },
      inputs: [{ name: "t/a.test.mjs", media_type: "text/javascript", content: "x" }],
      deliverable: [{ name: "f.mjs", media_type: "text/javascript", content: "x" }],
    };
    expect((await h.call(h.keys.platformA, "POST", "/v1/verifications", job)).status).toBe(500);
    expect((await h.call(h.keys.platformA, "POST", "/v1/verifications", job)).status).toBe(500);
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([
      expect.objectContaining({
        kind: "server_error",
        text: expect.stringContaining("/v1/verifications"),
      }),
    ]);
    expect(
      lines.some(
        (l) => l.msg === "server error" && String(l.error).includes("unexpected verifier bug"),
      ),
    ).toBe(true);

    const broken = new Alerter("https://hooks.example/down", {
      fetch: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    await expect(broken.notify("x", "y")).resolves.toBeUndefined();
  });
});
