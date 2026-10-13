/** Platforms manage their own keys: scoped creation, zero-downtime rolls, revocation. */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("API keys", () => {
  it("lists the account's keys without secrets and creates named keys shown once", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const created = await h.call(A, "POST", "/v1/api-keys", { name: "production server" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "production server",
      mode: "test",
      scopes: ["platform"],
      status: "active",
    });
    expect(created.body.key).toMatch(/^pd_test_/);
    expect((await h.call(created.body.key, "GET", "/v1/agreements")).status).toBe(200);

    const list = (await h.call(A, "GET", "/v1/api-keys")).body.data;
    expect(list).toHaveLength(2);
    expect(list.find((k: { current: boolean }) => k.current)).toBeDefined();
    expect(JSON.stringify(list)).not.toContain(created.body.key);
    // Other accounts' keys are invisible.
    expect((await h.call(h.keys.platformB, "GET", "/v1/api-keys")).body.data).toHaveLength(1);
  });

  it("makes verify-only keys that can check work but not touch agreements or money", async () => {
    h = await createHarness();
    const verify = (
      await h.call(h.keys.platformA, "POST", "/v1/api-keys", {
        name: "agent-7",
        scopes: ["verify"],
      })
    ).body.key;
    expect((await h.call(verify, "GET", "/v1/verifications")).status).toBe(200);
    expect((await h.call(verify, "GET", "/v1/spec-templates")).status).toBe(200);
    expect((await h.call(verify, "GET", "/v1/agreements")).status).toBe(403);
    expect(
      (
        await h.call(verify, "POST", "/v1/agreements", {
          buyer_ref: "b",
          seller_ref: "s",
          spec: specFixture(),
        })
      ).status,
    ).toBe(403);
    expect((await h.call(verify, "POST", "/v1/api-keys", {})).status).toBe(403);
    // No dashboard sign-in for machine keys.
    const login = await h.fetch("http://x/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `api_key=${encodeURIComponent(verify)}`,
      redirect: "manual",
    });
    expect(login.status).not.toBe(302);
  });

  it("never grants more than the caller has", async () => {
    h = await createHarness();
    const ops = await h.call(h.keys.platformA, "POST", "/v1/api-keys", { scopes: ["ops"] });
    expect(ops.status).toBe(403);
    expect(
      (await h.call(h.keys.platformA, "POST", "/v1/api-keys", { mode: "live" })).body.error.code,
    ).toBe("livemode_mismatch");
    const fromLive = await h.call(h.keys.live, "POST", "/v1/api-keys", { mode: "test" });
    expect(fromLive.body.key).toMatch(/^pd_test_/);
  });

  it("rolls a key with a grace period, then the old one stops working", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const extra = (await h.call(A, "POST", "/v1/api-keys", { name: "ci" })).body;
    const rolled = await h.call(A, "POST", `/v1/api-keys/${extra.id}/roll`, {
      expire_old_in_hours: 2,
    });
    expect(rolled.status).toBe(201);
    expect(rolled.body.key).toMatchObject({ name: "ci", status: "active" });
    expect(rolled.body.old_key.expires_at).toBe(
      new Date(h.clock.now.getTime() + 2 * HOUR).toISOString(),
    );
    expect((await h.call(extra.key, "GET", "/v1/agreements")).status).toBe(200);
    h.clock.advance(2 * HOUR + 1000);
    expect((await h.call(extra.key, "GET", "/v1/agreements")).status).toBe(401);
    expect((await h.call(rolled.body.key.key, "GET", "/v1/agreements")).status).toBe(200);
    const listed = (await h.call(A, "GET", "/v1/api-keys")).body.data;
    expect(listed.find((k: { id: string }) => k.id === extra.id).status).toBe("expired");

    const now = await h.call(A, "POST", `/v1/api-keys/${rolled.body.key.id}/roll`, {
      expire_old_in_hours: 0,
    });
    expect(now.body.old_key.status).toBe("revoked");
    expect((await h.call(rolled.body.key.key, "GET", "/v1/agreements")).status).toBe(401);
  });

  it("revokes another key (sessions included), but not the one making the request", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const other = (await h.call(A, "POST", "/v1/api-keys", {})).body;
    const self = (await h.call(A, "GET", "/v1/api-keys")).body.data.find(
      (k: { current: boolean }) => k.current,
    );
    const refused = await h.call(A, "DELETE", `/v1/api-keys/${self.id}`);
    expect(refused.body.error.code).toBe("cannot_revoke_current_key");
    const revoked = await h.call(A, "DELETE", `/v1/api-keys/${other.id}`);
    expect(revoked.body.status).toBe("revoked");
    expect((await h.call(other.key, "GET", "/v1/agreements")).status).toBe(401);
    expect((await h.call(h.keys.platformB, "DELETE", `/v1/api-keys/${self.id}`)).status).toBe(404);
  });
});
