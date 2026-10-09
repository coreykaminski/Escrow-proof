/**
 * Spec templates end to end: the criteria a template builds are the ones the real verifiers
 * check, so template-based jobs decide correctly with no model.
 */
import {
  guardedTransport,
  NodePermissionSandbox,
  verifyCode,
  verifyData,
} from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const PAGE = (fact: string) => `${"Background text. ".repeat(40)}${fact}`;
async function setup() {
  h = await createHarness({
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
    dataVerifier: (input) =>
      verifyData(input, {
        transport: guardedTransport(async (url) =>
          url.startsWith("https://stats.example/")
            ? {
                status: "ok",
                url,
                content_type: "text/plain",
                body: PAGE("Savings rose by 4 percent in 2025."),
              }
            : { status: "unreachable", url, http_status: 404 },
        ),
      }),
  });
}

const A = () => h.keys.platformA;
const verify = (
  template: { id: string; params: Record<string, unknown> },
  rest: Record<string, unknown>,
) => h.call(A(), "POST", "/v1/verifications", { template, ...rest });

describe("spec templates through the API", () => {
  it("lists the catalog with params as JSON Schema", async () => {
    await setup();
    const res = await h.call(A(), "GET", "/v1/spec-templates");
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual([
      "code.acceptance-tests",
      "data.dataset",
      "research.cited-brief",
      "translation.document",
    ]);
    expect(res.body.data[1].params.properties.min_records.type).toBe("integer");
  });

  it("code.acceptance-tests: public and hidden tests decide", async () => {
    await setup();
    const tests = {
      name: "tests/even.test.mjs",
      media_type: "text/javascript",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { isEven } from "../even.mjs";
test("[public-tests] four", () => assert.equal(isEven(4), true));
test("[hidden-tests] negative odd", () => assert.equal(isEven(-3), false));
`,
    };
    const template = {
      id: "code.acceptance-tests",
      params: { task: "Write isEven(n).", hidden_tests: true },
    };
    const code = (src: string) => [
      { name: "even.mjs", media_type: "text/javascript", content: src },
    ];
    const good = await verify(template, {
      inputs: [tests],
      deliverable: code("export const isEven = (n) => n % 2 === 0;"),
    });
    expect(good.body.outcome).toEqual({ kind: "release" });
    // Passes the public test but not the held-out one (n % 2 === 1 misses negatives).
    const bad = await verify(template, {
      inputs: [tests],
      deliverable: code("export const isEven = (n) => n % 2 !== 1;"),
    });
    expect(bad.body.outcome).toEqual({ kind: "refund" });
    const failed = bad.body.verification.report.criteria.filter(
      (c: { verdict: string }) => c.verdict === "fail",
    );
    expect(failed.map((c: { criterion_id: string }) => c.criterion_id)).toEqual(["hidden-tests"]);
  });

  it("data.dataset: schema, count and uniqueness decide", async () => {
    await setup();
    const schema = {
      name: "schema.json",
      media_type: "application/schema+json",
      content: JSON.stringify({
        type: "array",
        "x-unique-keys": ["city"],
        items: {
          type: "object",
          required: ["city", "population"],
          properties: { city: { type: "string" }, population: { type: "integer", minimum: 0 } },
        },
      }),
    };
    const template = {
      id: "data.dataset",
      params: { task: "List three cities.", min_records: 3, unique_key: "city" },
    };
    const csv = (rows: string) => [
      { name: "cities.csv", media_type: "text/csv", content: `city,population\n${rows}` },
    ];
    const run = (rows: string) => verify(template, { inputs: [schema], deliverable: csv(rows) });
    expect((await run("Lisbon,545000\nOslo,709000\nQuito,2800000\n")).body.outcome).toEqual({
      kind: "release",
    });
    expect((await run("Lisbon,545000\nOslo,709000\n")).body.outcome).toEqual({ kind: "refund" });
    expect((await run("Lisbon,545000\nLisbon,545000\nQuito,2800000\n")).body.outcome).toEqual({
      kind: "refund",
    });
  });

  it("research.cited-brief: source count, dead links and misquotes decide", async () => {
    await setup();
    const template = {
      id: "research.cited-brief",
      params: { task: "Summarize savings data.", min_sources: 2 },
    };
    const brief = (text: string) => [
      { name: "brief.md", media_type: "text/markdown", content: text },
    ];
    // Quotes are attributed per paragraph, so each paragraph with a quote cites one source.
    const two = `"Savings rose by 4 percent in 2025" (https://stats.example/a).\n\nSee also https://stats.example/b.`;
    expect((await verify(template, { deliverable: brief(two) })).body.outcome).toEqual({
      kind: "release",
    });
    const one = `"Savings rose by 4 percent in 2025" (https://stats.example/a).`;
    expect((await verify(template, { deliverable: brief(one) })).body.outcome).toEqual({
      kind: "refund",
    });
    const misquote = two.replace("4 percent", "9 percent");
    expect((await verify(template, { deliverable: brief(misquote) })).body.outcome).toEqual({
      kind: "refund",
    });
  });

  it("creates agreements from a template, recording where the spec came from", async () => {
    await setup();
    const res = await h.call(A(), "POST", "/v1/agreements/from-template", {
      buyer_ref: "b",
      seller_ref: "s",
      template: "translation.document",
      params: { source_language: "en", target_language: "fr", register: "legal" },
      amount: { value: 20_000, currency: "usd" },
      delivery_due_at: "2026-10-20T00:00:00Z",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "draft",
      spec: { title: "Translate English → French", vertical: "translation" },
      spec_source: { kind: "template", template: "translation.document", version: 1 },
      spec_warnings: [],
    });
    const ledger = (await h.call(A(), "GET", `/v1/agreements/${res.body.id}/ledger`)).body.data;
    expect(JSON.parse(JSON.stringify(ledger[0].payload)).spec_source).toEqual({
      kind: "template",
      template: "translation.document",
      version: 1,
    });

    const bad = await h.call(A(), "POST", "/v1/agreements/from-template", {
      buyer_ref: "b",
      seller_ref: "s",
      template: "data.dataset",
      params: { task: "x" },
      amount: { value: 1, currency: "usd" },
      delivery_due_at: "2026-10-20T00:00:00Z",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_params");
    const unknown = await verify(
      { id: "nope", params: {} },
      { deliverable: [{ name: "a", media_type: "text/plain", content: "x" }] },
    );
    expect(unknown.status).toBe(404);
    const both = await h.call(A(), "POST", "/v1/verifications", {
      template: { id: "data.dataset", params: {} },
      spec: {},
      deliverable: [{ name: "a", media_type: "text/plain", content: "x" }],
    });
    expect(both.status).toBe(400);
  });
});
