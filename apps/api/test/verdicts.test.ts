/**
 * Content-free verdict records (verdict/1): sealed daily into the ledger once final, served in a
 * public feed with inclusion proofs, linkable to a deal only with the parties' salt.
 */
import { FakeAnchorGateway } from "@proofdesk/chain";
import {
  fromHex,
  type LedgerProof,
  ledgerLeaf,
  verifyInclusion,
  verifyLedgerProof,
} from "@proofdesk/core";
import { NodePermissionSandbox, verifyCode } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR } from "./harness.ts";

let h: Harness;
let anchor: FakeAnchorGateway;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  anchor = new FakeAnchorGateway();
  h = await createHarness({
    anchor,
    codeVerifier: (input) => verifyCode(input, { sandbox: new NodePermissionSandbox() }),
  });
}

const spec = {
  version: 1,
  title: "Secret Project Falcon",
  request: "Write f() returning 1.",
  vertical: "code",
  criteria: [
    { id: "tests-pass", description: "Tests pass", check: "deterministic", critical: true },
  ],
};
const tests = {
  name: "t/a.test.mjs",
  media_type: "text/javascript",
  content: `import test from "node:test";\nimport { f } from "../f.mjs";\ntest("[tests-pass] f", () => { if (f() !== 1) throw new Error("no"); });\n`,
};

/** A live Verify API job, settled (final). */
async function finalVerdict(key: string, src = "export const f = () => 1;") {
  const job = (
    await h.call(key, "POST", "/v1/verifications", {
      spec,
      inputs: [tests],
      deliverable: [{ name: "f.mjs", media_type: "text/javascript", content: src }],
      buyer_ref: "acme_corp_buyer",
    })
  ).body;
  return job.id as string;
}

describe("verdict records", () => {
  it("seals final live verdicts daily, content-free, and proves them in the public feed", async () => {
    await setup();
    const passed = await finalVerdict(h.keys.live);
    const failed = await finalVerdict(h.keys.live, "export const f = () => 2;");
    await finalVerdict(h.keys.platformA); // test mode: never sealed
    h.clock.advance(HOUR);
    await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
    const anchored = (await h.call(h.keys.ops, "POST", "/v1/ops/ledger/anchor")).body;
    expect(anchored.status).toBe("anchored");

    const feed = (await h.call(null, "GET", "/verdicts.json")).body;
    expect(feed.data).toHaveLength(2);
    expect(feed.tree).toMatchObject({ root: anchored.root, anchor: expect.any(Object) });
    for (const item of feed.data) {
      expect(Object.keys(item.record).sort()).toEqual(
        ["decided_by", "final_on", "kind", "outcome", "subject", "v"].sort(),
      );
      expect(
        verifyInclusion(
          ledgerLeaf(item.entry_hash),
          item.leaf_index,
          feed.tree.size,
          item.inclusion.map(fromHex),
          fromHex(feed.tree.root),
        ),
      ).toBe(true);
    }
    // Same batch: one timestamp. Nothing identifying anywhere in the feed.
    expect(new Set(feed.data.map((d: { created_at: string }) => d.created_at)).size).toBe(1);
    const text = JSON.stringify(feed);
    for (const secret of [passed, failed, "Falcon", "acme_corp_buyer", "tests-pass"]) {
      expect(text).not.toContain(secret);
    }
    expect(
      feed.data.map((d: { record: { outcome: { kind: string } } }) => d.record.outcome.kind).sort(),
    ).toEqual(["refund", "release"]);

    // The parties' proof links the record to their agreement; a wrong salt doesn't.
    const proof = (await h.call(h.keys.live, "GET", `/v1/agreements/${passed}/proof`))
      .body as LedgerProof;
    expect(proof.verdict).toBeDefined();
    expect(verifyLedgerProof(proof)).toEqual({ ok: true, problems: [] });
    const wrongSalt = {
      ...proof,
      verdict: { ...(proof.verdict as NonNullable<LedgerProof["verdict"]>), salt: "00".repeat(32) },
    };
    expect(verifyLedgerProof(wrongSalt).problems).toContain(
      "the verdict record's subject isn't this agreement (salt mismatch)",
    );

    // Idempotent: nothing new to seal, nothing new to anchor.
    expect((await h.call(h.keys.ops, "POST", "/v1/ops/ledger/anchor")).body.status).toBe("current");
    expect((await h.call(null, "GET", "/verdicts.json")).body.data).toHaveLength(2);
    expect(
      (await h.call(null, "GET", `/verdicts.json?after=${feed.next_after}`)).body.data,
    ).toEqual([]);
  });

  it("shows the sealed record on the verdict report", async () => {
    await setup();
    const id = await finalVerdict(h.keys.live);
    h.clock.advance(HOUR);
    await h.call(h.keys.ops, "POST", "/v1/ops/run-due");
    await h.call(h.keys.ops, "POST", "/v1/ops/ledger/anchor");
    const link = (await h.call(h.keys.live, "POST", `/v1/agreements/${id}/report-links`, {})).body;
    const html = await (await h.fetch(link.url)).text();
    expect(html).toContain("Public verdict record");
  });
});
