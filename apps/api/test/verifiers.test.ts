/**
 * Code and data verification through the API (Part 8): the real verifiers, with the Node
 * permission sandbox and an offline fixture web, no model.
 */
import {
  guardedTransport,
  NodePermissionSandbox,
  verifyCode,
  verifyData,
} from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  h = await createHarness({
    codeVerifier: (input) =>
      verifyCode(input, { sandbox: new NodePermissionSandbox(), timeoutMs: 5_000 }),
    dataVerifier: (input) =>
      verifyData(input, {
        transport: guardedTransport(async (url) =>
          url === "https://stats.example/report"
            ? {
                status: "ok",
                url,
                content_type: "text/plain",
                body: `${"Background text. ".repeat(40)}Median household savings rose by 4 percent in 2025.`,
              }
            : { status: "unreachable", url, http_status: 404 },
        ),
      }),
  });
}

async function delivered(
  spec: Record<string, unknown>,
  inputs: { name: string; media_type: string; content: string }[],
  artifacts: { name: string; media_type: string; content: string }[],
) {
  const A = h.keys.platformA;
  const agr = (await h.call(A, "POST", "/v1/agreements", { buyer_ref: "b", seller_ref: "s", spec }))
    .body;
  const withInputs = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, { inputs });
  expect(withInputs.status).toBe(200);
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInputs.body.spec_hash,
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h1" });
  h.clock.advance(HOUR);
  await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, { artifacts });
  return agr.id as string;
}

const verify = (id: string) => h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/verify`);

const codeSpec = specFixture({
  title: "isEven(n)",
  request: "Write isEven(n).",
  vertical: "code",
  criteria: [
    {
      id: "tests-pass",
      description: "All acceptance tests pass",
      check: "deterministic",
      critical: true,
    },
  ],
});
const TESTS = {
  name: "tests/even.test.mjs",
  media_type: "text/javascript",
  content: `import test from "node:test";
import assert from "node:assert/strict";
import { isEven } from "../even.mjs";
test("[tests-pass] even", () => assert.equal(isEven(4), true));
test("[tests-pass] odd", () => assert.equal(isEven(7), false));
`,
};
const code = (src: string) => [{ name: "even.mjs", media_type: "text/javascript", content: src }];

describe("code jobs", () => {
  it("runs the buyer's tests in the sandbox and releases passing code", async () => {
    await setup();
    const id = await delivered(
      codeSpec,
      [TESTS],
      code("export const isEven = (n) => n % 2 === 0;"),
    );
    const res = await verify(id);
    expect(res.status).toBe(200);
    expect(res.body.agreement.status).toBe("decided");
    expect(res.body.agreement.outcome).toEqual({ kind: "release" });
    const v = res.body.verification;
    expect(v.engine_version).toMatch(/^code-v1\//);
    expect(v.report.tests).toMatchObject({ passed: 2, failed: 0, sandbox: "node-permission" });

    const page = await h.call(h.keys.ops, "GET", `/v1/ops/agreements/${id}`);
    expect(page.status).toBe(200);
  });

  it("refunds failing code, and shows the test run on the case page", async () => {
    await setup();
    const id = await delivered(codeSpec, [TESTS], code("export const isEven = () => true;"));
    const res = await verify(id);
    expect(res.body.agreement.outcome).toEqual({ kind: "refund" });
    expect(res.body.verification.report.findings.map((f: { kind: string }) => f.kind)).toContain(
      "tests_failed",
    );

    const login = await h.fetch("http://x/dashboard/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `api_key=${encodeURIComponent(h.keys.ops)}`,
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const html = await (
      await h.fetch(`http://x/dashboard/agreements/${id}`, { headers: { cookie } })
    ).text();
    expect(html).toContain("Test run");
    expect(html).toContain("[tests-pass] odd");
  });

  it("needs acceptance tests attached", async () => {
    await setup();
    const id = await delivered(
      codeSpec,
      [{ name: "README.md", media_type: "text/markdown", content: "no tests" }],
      code("export const isEven = (n) => n % 2 === 0;"),
    );
    const res = await verify(id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("missing_tests");
  });
});

describe("data jobs", () => {
  const dataSpec = specFixture({
    title: "City list",
    request: "List at least 3 cities with population.",
    vertical: "data",
    criteria: [
      {
        id: "matches-schema",
        description: "Every row is valid",
        check: "deterministic",
        critical: true,
      },
      {
        id: "record-count",
        description: "At least 3 records",
        check: "deterministic",
        critical: true,
      },
    ],
  });
  const schema = {
    name: "schema.json",
    media_type: "application/schema+json",
    content: JSON.stringify({
      type: "array",
      items: {
        type: "object",
        required: ["city", "population"],
        properties: { population: { type: "integer", minimum: 0 } },
      },
    }),
  };
  const csv = (rows: string) => [
    { name: "cities.csv", media_type: "text/csv", content: `city,population\n${rows}` },
  ];

  it("validates a CSV against the buyer's schema", async () => {
    await setup();
    const ok = await delivered(
      dataSpec,
      [schema],
      csv("Lisbon,545000\nOslo,709000\nQuito,2800000\n"),
    );
    expect((await verify(ok)).body.agreement.outcome).toEqual({ kind: "release" });

    const bad = await delivered(dataSpec, [schema], csv("Lisbon,545000\nOslo,lots\n"));
    const res = await verify(bad);
    expect(res.body.agreement.outcome).toEqual({ kind: "refund" });
    expect(res.body.verification.report.data.records).toBe(2);
  });

  it("checks a research brief's citations and quotes, offline and SSRF-guarded", async () => {
    await setup();
    const spec = specFixture({
      title: "Savings brief",
      request: "Summarize household savings, citing sources.",
      vertical: "data",
      criteria: [
        {
          id: "cites-sources",
          description: "Every cited link loads",
          check: "deterministic",
          critical: true,
        },
        {
          id: "quotes-verbatim",
          description: "Quotes are verbatim",
          check: "deterministic",
          critical: true,
        },
      ],
    });
    const brief = (quote: string, extra = "") => [
      {
        name: "brief.md",
        media_type: "text/markdown",
        content: `Savings grew: "${quote}" (https://stats.example/report).${extra}`,
      },
    ];
    const ok = await delivered(
      spec,
      [],
      brief("median household savings rose by 4 percent in 2025"),
    );
    expect((await verify(ok)).body.agreement.outcome).toEqual({ kind: "release" });

    const misquoted = await delivered(
      spec,
      [],
      brief("median household savings rose by 9 percent in 2025"),
    );
    expect((await verify(misquoted)).body.agreement.outcome).toEqual({ kind: "refund" });

    const ssrf = await delivered(
      spec,
      [],
      brief(
        "median household savings rose by 4 percent in 2025",
        "\n\nRaw: http://169.254.169.254/latest/",
      ),
    );
    const res = await verify(ssrf);
    expect(res.body.agreement.outcome).toEqual({ kind: "refund" });
    expect(res.body.verification.report.data.citations).toContainEqual(
      expect.objectContaining({ url: "http://169.254.169.254/latest/", status: "blocked" }),
    );
  });
});
