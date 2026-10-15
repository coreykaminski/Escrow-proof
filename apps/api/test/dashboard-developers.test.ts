/** The dashboard's developer page (keys, webhooks) and events viewer. */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function session(key: string) {
  const login = await h.fetch("http://x/dashboard/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `api_key=${encodeURIComponent(key)}`,
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await (
    await h.fetch("http://x/dashboard/developers", { headers: { cookie } })
  ).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const post = async (path: string, fields: Record<string, string> = {}) =>
    (
      await h.fetch(`http://x${path}`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, ...fields }).toString(),
      })
    ).text();
  const get = async (path: string) =>
    (await h.fetch(`http://x${path}`, { headers: { cookie } })).text();
  return { page, post, get, cookie };
}

describe("developer page", () => {
  it("creates a verify-only key shown once, rolls and revokes keys", async () => {
    h = await createHarness();
    const s = await session(h.keys.platformA);
    expect(s.page).toContain("this session");
    const created = await s.post("/dashboard/developers/keys", {
      name: "agent-7",
      scope: "verify",
    });
    const key = /pd_test_[A-Za-z0-9_-]{20,}/.exec(created)?.[0] as string;
    expect(created).toContain("Copy it now");
    expect((await h.call(key, "GET", "/v1/verifications")).status).toBe(200);
    expect((await h.call(key, "GET", "/v1/agreements")).status).toBe(403);
    // Listed by prefix only afterwards.
    expect(await s.get("/dashboard/developers")).not.toContain(key);

    const keys = (await h.call(h.keys.platformA, "GET", "/v1/api-keys")).body.data;
    const agentKey = keys.find((k: { name: string }) => k.name === "agent-7");
    const rolled = await s.post(`/dashboard/developers/keys/${agentKey.id}/roll`);
    expect(rolled).toContain("keeps working for 24 hours");
    expect(await s.post(`/dashboard/developers/keys/${agentKey.id}/revoke`)).toContain(
      "Key revoked",
    );
    expect((await h.call(key, "GET", "/v1/verifications")).status).toBe(401);

    const self = keys.find((k: { current: boolean }) => k.current);
    expect(await s.post(`/dashboard/developers/keys/${self.id}/revoke`)).toContain(
      "roll it instead",
    );
    // Another account's key can't be touched.
    const other = (await h.call(h.keys.platformB, "GET", "/v1/api-keys")).body.data[0];
    expect(await s.post(`/dashboard/developers/keys/${other.id}/revoke`)).toContain("not found");
  });

  it("adds a webhook endpoint (secret once), tests, replays and deletes it", async () => {
    const received: string[] = [];
    h = await createHarness({
      fetch: (async (_u: string, init?: RequestInit) => {
        received.push(JSON.parse(String(init?.body)).type);
        return new Response("ok");
      }) as typeof fetch,
    });
    const s = await session(h.keys.platformA);
    const added = await s.post("/dashboard/developers/webhooks", {
      url: "https://platform.example/hooks",
      event_types: "agreement.decide, agreement.settle",
    });
    expect(added).toMatch(/whsec_[A-Za-z0-9_-]+/);
    expect(added).toContain("Events: agreement.decide, agreement.settle");
    const ep = (await h.call(h.keys.platformA, "GET", "/v1/webhook-endpoints")).body.data[0];

    expect(await s.post(`/dashboard/developers/webhooks/${ep.id}/test`)).toContain(
      "Test event delivered: HTTP 200",
    );
    expect(received).toEqual(["webhook.test"]);
    expect(
      await s.post(`/dashboard/developers/webhooks/${ep.id}/replay`, { from_event: "evt_1" }),
    ).toContain("will be re-sent");
    expect(
      await s.post(`/dashboard/developers/webhooks/${ep.id}/replay`, { from_event: "nope" }),
    ).toContain("like evt_123");
    expect(await s.post("/dashboard/developers/webhooks", { url: "not a url" })).toContain(
      "Enter a full URL",
    );
    expect(await s.post(`/dashboard/developers/webhooks/${ep.id}/delete`)).toContain(
      "Endpoint deleted",
    );
    expect((await h.call(h.keys.platformA, "GET", "/v1/webhook-endpoints")).body.data).toEqual([]);
  });

  it("browses this account's events with a type filter", async () => {
    h = await createHarness();
    const agr = (
      await h.call(h.keys.platformA, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: specFixture(),
      })
    ).body;
    await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
      spec_hash: agr.spec_hash,
    });
    await h.call(h.keys.platformB, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    });
    const s = await session(h.keys.platformA);
    const all = await s.get("/dashboard/events");
    expect(all).toContain("agreement.created");
    expect(all).toContain("agreement.approve_spec");
    expect((all.match(/agreement\.created/g) ?? []).length).toBe(1);
    const filtered = await s.get("/dashboard/events?type=agreement.approve_spec");
    expect(filtered).not.toContain("agreement.created");
  });

  it("refuses forged forms", async () => {
    h = await createHarness();
    const s = await session(h.keys.platformA);
    const res = await h.fetch("http://x/dashboard/developers/keys", {
      method: "POST",
      headers: { cookie: s.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "forged", name: "x" }).toString(),
    });
    expect(res.status).toBe(403);
  });
});
