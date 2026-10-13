/** Self-serve sandbox sign-up: test keys only, rate-limited, with daily quotas. */
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
  delete process.env.SANDBOX_DAILY_CHECKS;
});

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

describe("self-serve sandbox sign-up", () => {
  it("gives a working test key on the page, once", async () => {
    h = await createHarness();
    expect((await h.fetch("http://x/signup")).status).toBe(200);
    const res = await h.fetch(
      "http://x/signup",
      form({ name: "Acme Agents", email: "dev@acme.example" }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const key = /pd_test_[A-Za-z0-9_-]+/.exec(await res.text())?.[0] as string;
    expect(key).toBeDefined();
    const list = await h.call(key, "GET", "/v1/agreements");
    expect(list.status).toBe(200);
    // Test keys can't touch live mode or ops.
    expect((await h.call(key, "GET", "/v1/ops/metrics")).status).toBe(403);
  });

  it("has a JSON endpoint for scripts and agents, and validates input", async () => {
    h = await createHarness();
    const res = await h.call(null, "POST", "/sandbox/signup", {
      name: "Bot Co",
      email: "bot@co.example",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "sandbox_account",
      mode: "test",
      daily_limits: { verifications: 100, spec_drafts: 20 },
    });
    expect(res.body.api_key).toMatch(/^pd_test_/);
    expect(
      (await h.call(null, "POST", "/sandbox/signup", { name: "x", email: "nope" })).status,
    ).toBe(400);
    const page = await h.fetch("http://x/signup", form({ name: "A", email: "bad" }));
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("valid email");
  });

  it("is rate-limited per IP, and can be switched off", async () => {
    h = await createHarness({ rateLimits: { signupsPerHour: 2 } });
    const post = () =>
      h.call(null, "POST", "/sandbox/signup", { name: "Spam", email: "s@spam.example" });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);

    const off = createApp({ db: h.handle.db, now: () => h.clock.now, selfServeSignup: false });
    expect((await off.request("/signup")).status).toBe(404);
    expect(
      (
        await off.request("/sandbox/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Acme", email: "a@acme.example" }),
        })
      ).status,
    ).toBe(404);
  });

  it("caps a sandbox's daily verifications (other accounts are unaffected)", async () => {
    process.env.SANDBOX_DAILY_CHECKS = "1";
    h = await createHarness({
      codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
    });
    const key = (
      await h.call(null, "POST", "/sandbox/signup", { name: "Quota Co", email: "q@co.example" })
    ).body.api_key;
    const job = {
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
    };
    expect((await h.call(key, "POST", "/v1/verifications", job)).status).toBe(201);
    const second = await h.call(key, "POST", "/v1/verifications", job);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("sandbox_quota_exceeded");
    // A provisioned (non-self-serve) account isn't capped.
    expect((await h.call(h.keys.platformA, "POST", "/v1/verifications", job)).status).toBe(201);
    expect((await h.call(h.keys.platformA, "POST", "/v1/verifications", job)).status).toBe(201);
  });
});
