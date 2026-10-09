import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { OPERATIONS, openApiDocument } from "../src/openapi.ts";
import { createHarness } from "./harness.ts";

describe("API reference", () => {
  it("documents every route the app serves, and nothing it doesn't", async () => {
    const h = await createHarness();
    const app = createApp({ db: h.handle.db, now: () => new Date() });
    const served = new Set(
      app.routes
        .filter((r) => r.method !== "ALL")
        // HTML pages (dashboard, share and pay links, status, pricing) aren't part of the API.
        .filter((r) => !/^\/(dashboard|r\/|pay\/|status$|pricing$|accuracy$)/.test(r.path))
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/\/:(\w+)/g, "/{$1}")}`),
    );
    const documented = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));
    documented.add("get /openapi.json");
    documented.add("get /docs");
    expect([...served].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !served.has(r))).toEqual([]);
    await h.close();
  });

  it("is served as OpenAPI 3.1 with request schemas from the real validators", async () => {
    const h = await createHarness();
    const res = await h.call(null, "GET", "/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    const create = res.body.paths["/v1/agreements/from-request"].post;
    const schema = create.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(
      expect.arrayContaining(["request", "amount", "delivery_due_at"]),
    );
    expect(create.parameters.map((p: { name: string }) => p.name)).toContain("Idempotency-Key");
    expect(res.body.paths["/health"].get.security).toEqual([]);
    const docs = await h.fetch("http://proofdesk.test/docs");
    expect(docs.headers.get("content-type")).toContain("text/html");
    expect(await docs.text()).toContain('data-url="/openapi.json"');
    await h.close();
  });

  it("builds without throwing for every operation", () => {
    expect(Object.keys(openApiDocument().paths).length).toBeGreaterThan(30);
  });
});
