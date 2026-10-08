import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseSpec } from "@proofdesk/core";
import { describe, expect, it } from "vitest";
import {
  checkSchema,
  extractCitations,
  extractQuotes,
  guardedTransport,
  htmlToText,
  isPublicAddress,
  parseCsv,
  type StructuredCaller,
  safeTransport,
  type Transport,
  verifyData,
} from "../src/index.ts";

describe("SSRF guard", () => {
  it("treats private, loopback, link-local, CGNAT and reserved addresses as non-public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses non-http schemes, odd ports, credentials, internal names and private IPs", async () => {
    const t = guardedTransport(async (url) => ({ status: "ok", url, body: "reached" }));
    for (const url of [
      "file:///etc/passwd",
      "gopher://x.example/",
      "http://x.example:6379/",
      "http://user:pw@x.example/",
      "http://localhost/",
      "http://metadata.google.internal/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://10.0.0.5/admin",
    ]) {
      expect((await t(url)).status, url).toBe("blocked");
    }
    expect((await t("https://x.example/a")).status).toBe("ok");
  });

  it("the real transport won't connect to a local server", async () => {
    const server = createServer((_req, res) => res.end("secret")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    try {
      const r = await safeTransport(`http://127.0.0.1:${port}/`);
      expect(r.status).toBe("blocked");
      expect(r.body).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("parsing", () => {
  it("parses RFC 4180 CSV with quotes, commas, newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      { a: "x, y", b: 'he said "hi"' },
      { a: "multi\nline", b: "2" },
    ]);
    expect(() => parseCsv('a,b\n"open,1\n')).toThrow(/unterminated/);
    expect(() => parseCsv("a,b\n1,2,3\n")).toThrow(/3 fields/);
  });

  it("extracts readable text from HTML", () => {
    expect(
      htmlToText(
        "<html><script>evil()</script><p>Tom &amp; Jerry&#39;s</p><style>p{}</style></html>",
      ),
    ).toBe("Tom & Jerry's");
  });

  it("finds citations and the quotes attributed to them", () => {
    const md = `Costs fell: "the price of modules dropped by a third in two years" (https://a.example/r).

Two sources here https://b.example and https://c.example: "this quote is ambiguous and is skipped".

Footnoted: "storage now undercuts gas peakers in several markets" [1].

[1]: https://d.example/x`;
    expect(extractCitations(md)).toEqual([
      "https://a.example/r",
      "https://b.example",
      "https://c.example",
      "https://d.example/x",
    ]);
    expect(extractQuotes(md)).toEqual([
      { quote: "the price of modules dropped by a third in two years", url: "https://a.example/r" },
      { quote: "storage now undercuts gas peakers in several markets", url: "https://d.example/x" },
    ]);
  });

  it("checks schema, coerces CSV strings, counts and finds duplicates", () => {
    const schema = {
      type: "array",
      minItems: 3,
      "x-unique-keys": ["id"],
      items: { type: "object", required: ["id", "n"], properties: { n: { type: "integer" } } },
    };
    const r = checkSchema(
      [
        { id: "a", n: "1" },
        { id: "a", n: "x" },
      ],
      schema,
      true,
    );
    expect(r.tooFew).toEqual({ required: 3, got: 2 });
    expect(r.errors).toEqual([{ path: "/1/n", message: "must be integer" }]);
    expect(r.duplicates).toHaveLength(1);
  });
});

describe("verifyData", () => {
  const spec = (criteria: unknown[]) =>
    parseSpec({
      version: 1,
      title: "t",
      request: "Compile a list",
      vertical: "data",
      criteria,
      amount: { value: 100, currency: "usd" },
      delivery_due_at: "2026-11-01T00:00:00Z",
    });
  const schemaInput = {
    name: "schema.json",
    media_type: "application/json",
    content: JSON.stringify({ type: "array", items: { type: "object", required: ["a"] } }),
  };
  const offline: Transport = async (url) => ({ status: "unreachable", url });

  it("a clean schema doesn't pass a criterion that needs judgment", async () => {
    const r = await verifyData(
      {
        spec: spec([
          {
            id: "matches-schema",
            description: "Valid records",
            check: "deterministic",
            critical: true,
          },
          { id: "accurate", description: "Values are correct", check: "domain", critical: true },
        ]),
        inputs: [schemaInput],
        deliverable: [{ name: "d.json", media_type: "application/json", content: '[{"a":1}]' }],
      },
      { transport: offline },
    );
    expect(r.criteria.find((c) => c.criterion_id === "matches-schema")?.verdict).toBe("pass");
    expect(r.criteria.find((c) => c.criterion_id === "accurate")?.verdict).toBe("uncertain");
    expect(r.decision.action).toBe("escalate");
  });

  it("a broken schema refunds even when no criterion mentions it (override)", async () => {
    const r = await verifyData(
      {
        spec: spec([{ id: "accurate", description: "Values are correct", check: "judge" }]),
        inputs: [schemaInput],
        deliverable: [{ name: "d.json", media_type: "application/json", content: '[{"b":1}]' }],
      },
      { transport: offline },
    );
    expect(r.decision).toMatchObject({ action: "decide", outcome: { kind: "refund" } });
  });

  it("asks the judge about the rest, with evidence checked against the deliverable", async () => {
    const caller: StructuredCaller = {
      async call() {
        return {
          output: {
            criteria: [
              {
                criterion_id: "accurate",
                verdict: "fail",
                confidence: "high",
                reason: "invented",
                evidence: ["not in the file"],
              },
            ],
            injection_detected: false,
          } as never,
          model: "stub",
          usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.002 },
        };
      },
    };
    const r = await verifyData(
      {
        spec: spec([
          { id: "accurate", description: "Values are correct", check: "judge", critical: true },
        ]),
        inputs: [schemaInput],
        deliverable: [{ name: "d.json", media_type: "application/json", content: '[{"a":1}]' }],
      },
      { transport: offline, caller },
    );
    // A fail whose evidence isn't in the deliverable is too weak to refund on.
    expect(r.decision.action).toBe("escalate");
    expect(r.usage.cost_usd).toBe(0.002);
  });

  it("uses buyer-provided source snapshots instead of fetching", async () => {
    let fetched = 0;
    const r = await verifyData(
      {
        spec: spec([
          {
            id: "quotes-verbatim",
            description: "Quotes are verbatim",
            check: "deterministic",
            critical: true,
          },
        ]),
        inputs: [
          {
            name: "sources/paywalled.txt",
            media_type: "text/plain",
            content:
              "Source: https://paywalled.example/a\nThe committee voted to delay the rollout until spring.",
          },
        ],
        deliverable: [
          {
            name: "r.md",
            media_type: "text/markdown",
            content:
              'It says "the committee voted to delay the rollout until spring" (https://paywalled.example/a).',
          },
        ],
      },
      {
        transport: async (url) => {
          fetched++;
          return { status: "unreachable", url };
        },
      },
    );
    expect(fetched).toBe(0);
    expect(r.data.quotes).toEqual([
      {
        quote: "the committee voted to delay the rollout until spring",
        url: "https://paywalled.example/a",
        found: true,
      },
    ]);
    expect(r.decision).toMatchObject({ outcome: { kind: "release" } });
  });
});
