/** Data retention: documents deleted once final + N days (or on request); hashes keep verifying. */
import { type LedgerProof, verifyLedgerProof } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { deleteExpiredContent } from "../src/services/retention.ts";
import { createHarness, type Harness, HOUR } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const DAY = 24 * HOUR;

async function setup() {
  h = await createHarness({
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
  });
}

const SECRET = "export const f = () => 1; // ACME internal pricing logic";
/** A settled (final) Verify API job whose files hold something private. */
async function finalJob(key: string) {
  const job = (
    await h.call(key, "POST", "/v1/verifications", {
      template: { id: "code.acceptance-tests", params: { task: "Write f()." } },
      inputs: [
        {
          name: "t/a.test.mjs",
          media_type: "text/javascript",
          content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[public-tests] f returns 1", () => { if (f() !== 1) throw new Error("got " + f()); });\n`,
        },
      ],
      deliverable: [{ name: "f.mjs", media_type: "text/javascript", content: SECRET }],
    })
  ).body;
  h.clock.advance(HOUR);
  await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
  return job.id as string;
}

describe("retention", () => {
  it("deletes documents and report evidence after the period; every hash still verifies", async () => {
    await setup();
    const id = await finalJob(h.keys.live);
    const before = (await h.call(h.keys.live, "GET", `/v1/agreements/${id}/verifications`)).body
      .data[0];

    h.clock.advance(89 * DAY);
    expect((await deleteExpiredContent(h.handle.db, { now: h.clock.now })).deleted).toEqual([]);
    h.clock.advance(2 * DAY);
    expect((await deleteExpiredContent(h.handle.db, { now: h.clock.now })).deleted).toEqual([id]);

    const agr = (await h.call(h.keys.live, "GET", `/v1/agreements/${id}`)).body;
    expect(agr.content_deleted_at).toBe(h.clock.now.toISOString());
    const deliveries = (
      await h.call(h.keys.live, "GET", `/v1/agreements/${id}/deliveries?include_content=true`)
    ).body.data;
    expect(deliveries[0].artifacts[0]).toMatchObject({ name: "f.mjs", content: "" });
    expect(deliveries[0].artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const inputs = (
      await h.call(h.keys.live, "GET", `/v1/agreements/${id}/inputs?include_content=true`)
    ).body.data;
    expect(inputs[0].content).toBe("");
    const after = (await h.call(h.keys.live, "GET", `/v1/agreements/${id}/verifications`)).body
      .data[0];
    expect(after.report_hash).toBe(before.report_hash);
    expect(after.report).toMatchObject({
      redacted: true,
      decision: before.report.decision,
      tests: { log: "" },
    });
    expect(after.report.criteria[0]).toMatchObject({
      criterion_id: "public-tests",
      verdict: "pass",
      signals: [],
    });
    expect(JSON.stringify(after)).not.toContain("ACME");

    const ledger = (await h.call(h.keys.live, "GET", `/v1/agreements/${id}/ledger`)).body.data;
    expect(ledger.at(-1)).toMatchObject({
      type: "agreement.content_deleted",
      payload: { reason: "retention", artifacts: 1, inputs: 1 },
    });
    expect((await h.call(h.keys.ops, "GET", "/v1/ops/ledger/verify")).body.ok).toBe(true);
    const proof = (await h.call(h.keys.live, "GET", `/v1/agreements/${id}/proof`))
      .body as LedgerProof;
    expect(verifyLedgerProof(proof).ok).toBe(true);

    // Pages still render.
    const link = (await h.call(h.keys.live, "POST", `/v1/agreements/${id}/report-links`, {})).body;
    const html = await (await h.fetch(link.url)).text();
    expect(html).toContain("deleted on");
    expect(html).not.toContain("ACME");
    // Idempotent.
    expect((await deleteExpiredContent(h.handle.db, { now: h.clock.now })).deleted).toEqual([]);
  });

  it("honours a per-account period and never touches unfinished agreements", async () => {
    await setup();
    const id = await finalJob(h.keys.platformA);
    const acct = (await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}`)).body;
    const open = (
      await h.call(h.keys.platformA, "POST", "/v1/agreements/from-template", {
        buyer_ref: "b",
        seller_ref: "s",
        template: "code.acceptance-tests",
        params: { task: "Write g()." },
        amount: { value: 1_000, currency: "usd" },
        delivery_due_at: "2027-01-01T00:00:00Z",
      })
    ).body;
    const [row] = await h.handle.db
      .select({ accountId: schema.agreements.accountId })
      .from(schema.agreements);
    const res = await h.call(h.keys.ops, "PUT", `/v1/ops/accounts/${row?.accountId}/retention`, {
      days: 7,
    });
    expect(res.body.retention_days).toBe(7);
    h.clock.advance(8 * DAY);
    const { deleted } = await deleteExpiredContent(h.handle.db, { now: h.clock.now });
    expect(deleted).toEqual([id]);
    expect(deleted).not.toContain(open.id);
    expect(acct.status).toBe("settled");
  });

  it("deletes on request, only once final, only for the owner", async () => {
    await setup();
    const id = await finalJob(h.keys.platformA);
    const draft = (
      await h.call(h.keys.platformA, "POST", "/v1/agreements/from-template", {
        buyer_ref: "b",
        seller_ref: "s",
        template: "data.dataset",
        params: { task: "List cities.", min_records: 3 },
        amount: { value: 1_000, currency: "usd" },
        delivery_due_at: "2027-01-01T00:00:00Z",
      })
    ).body;
    const early = await h.call(h.keys.platformA, "DELETE", `/v1/agreements/${draft.id}/content`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_final");
    expect((await h.call(h.keys.platformB, "DELETE", `/v1/agreements/${id}/content`)).status).toBe(
      404,
    );
    const res = await h.call(h.keys.platformA, "DELETE", `/v1/agreements/${id}/content`);
    expect(res.status).toBe(200);
    expect(res.body.content_deleted_at).not.toBeNull();
    const again = await h.call(h.keys.platformA, "DELETE", `/v1/agreements/${id}/content`);
    expect(again.body.content_deleted_at).toBe(res.body.content_deleted_at);
    const ledger = (await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}/ledger`)).body.data;
    expect(
      ledger.filter((e: { type: string }) => e.type === "agreement.content_deleted"),
    ).toHaveLength(1);
    expect(ledger.at(-1).payload.reason).toBe("request");
  });
});
