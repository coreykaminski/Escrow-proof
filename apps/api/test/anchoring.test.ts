/** Part 10: anchoring the ledger head on-chain, and checking anchors against the ledger. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAnchorGateway } from "@proofdesk/chain";
import { fromHex, type LedgerProof, verifyConsistency, verifyLedgerProof } from "@proofdesk/core";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
let anchor: FakeAnchorGateway;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  anchor = new FakeAnchorGateway();
  h = await createHarness({ anchor });
}

const O = () => h.keys.ops;
const agreement = async () =>
  (
    await h.call(h.keys.platformA, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    })
  ).body;

describe("ledger anchoring", () => {
  it("posts the verified head, records it, and doesn't re-anchor its own record", async () => {
    await setup();
    expect((await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body).toEqual({ status: "empty" });
    const agr = await agreement();
    const ledger = (await h.call(h.keys.platformA, "GET", `/v1/agreements/${agr.id}/ledger`)).body
      .data;
    const head = ledger.at(-1);
    const tree = (await h.call(null, "GET", "/ledger/checkpoint.json")).body;
    expect(tree).toMatchObject({ scheme: "rfc6962-sha256", size: head.seq, anchored: null });

    const first = (await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body;
    expect(first).toMatchObject({ status: "anchored", seq: head.seq, root: tree.root });
    expect(anchor.anchors).toEqual([
      expect.objectContaining({ seq: head.seq, headHash: tree.root }),
    ]);
    expect((await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body.status).toBe("current");

    await agreement();
    const second = (await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body;
    expect(second.status).toBe("anchored");
    expect(second.seq).toBeGreaterThan(head.seq);

    const check = (await h.call(O(), "GET", "/v1/ops/ledger/anchors")).body;
    expect(check.ok).toBe(true);
    expect(check.anchors).toHaveLength(2);
  });

  it("detects an anchor that doesn't match the ledger", async () => {
    await setup();
    await agreement();
    await anchor.anchor(1, "f".repeat(64));
    const check = (await h.call(O(), "GET", "/v1/ops/ledger/anchors")).body;
    expect(check.ok).toBe(false);
    expect(check.anchors[0]).toMatchObject({
      seq: 1,
      ok: false,
      problem: "root differs from the anchor",
    });
  });

  it("shows the anchor on verdict reports it covers, and on the status page", async () => {
    await setup();
    const agr = await agreement();
    await h.call(O(), "POST", "/v1/ops/ledger/anchor");
    const link = (
      await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/report-links`, {})
    ).body;
    const html = await (await h.fetch(link.url)).text();
    expect(html).toContain("Anchored on-chain");
    expect(html).toContain(anchor.contract);

    const status = (await h.call(null, "GET", "/status.json")).body;
    expect(
      status.components.find((c: { name: string }) => c.name.startsWith("Ledger anchoring")).status,
    ).toBe("operational");
    h.clock.advance(72 * HOUR);
    const stale = (await h.call(null, "GET", "/status.json")).body;
    expect(
      stale.components.find((c: { name: string }) => c.name.startsWith("Ledger anchoring")).status,
    ).toBe("degraded");
  });

  it("returns 503 when anchoring isn't configured", async () => {
    h = await createHarness();
    expect((await h.call(O(), "POST", "/v1/ops/ledger/anchor")).status).toBe(503);
  });
});

describe("ledger proofs (RFC 6962)", () => {
  it("proves an agreement's entries against the anchored tree head, offline", async () => {
    await setup();
    const agr = await agreement();
    await agreement(); // someone else's activity, before and after
    await h.call(O(), "POST", "/v1/ops/ledger/anchor");
    await agreement();

    const proof = (await h.call(h.keys.platformA, "GET", `/v1/agreements/${agr.id}/proof`))
      .body as LedgerProof;
    expect(proof.tree.anchor).toMatchObject({ contract: anchor.contract });
    expect(proof.tree.root).toBe(anchor.anchors[0]?.headHash);
    expect(verifyLedgerProof(proof)).toEqual({ ok: true, problems: [] });
    // Only this agreement's entries are in it.
    const own = (await h.call(h.keys.platformA, "GET", `/v1/agreements/${agr.id}/ledger`)).body
      .data;
    expect(proof.entries.map((e) => e.seq)).toEqual(own.map((e: { seq: number }) => e.seq));

    // Tampering with any entry, or claiming another root, fails.
    const edited = structuredClone(proof);
    (edited.entries[0] as { payload: string }).payload = edited.entries[0]?.payload.replace(
      '"to":"draft"',
      '"to":"funded"',
    ) as string;
    expect(verifyLedgerProof(edited).problems[0]).toContain("content doesn't match");
    expect(verifyLedgerProof({ ...proof, tree: { ...proof.tree, root: "ab".repeat(32) } }).ok).toBe(
      false,
    );

    // The CLI checks the same file.
    const dir = mkdtempSync(join(tmpdir(), "pd-proof-"));
    writeFileSync(join(dir, "proof.json"), JSON.stringify(proof));
    const out = execFileSync("npx", ["tsx", "scripts/verify-proof.ts", join(dir, "proof.json")], {
      encoding: "utf8",
    });
    expect(out).toContain("✓");
  });

  it("the public report links a proof and hides global sequence numbers", async () => {
    await setup();
    await agreement();
    await agreement();
    const agr = await agreement();
    const link = (
      await h.call(h.keys.platformA, "POST", `/v1/agreements/${agr.id}/report-links`, {})
    ).body;
    const html = await (await h.fetch(link.url)).text();
    expect(html).toContain("download the proof");
    expect(html).not.toMatch(/<td class="mono">3<\/td>/);
    const proof = (await (await h.fetch(`${link.url}/proof.json`)).json()) as LedgerProof;
    expect(verifyLedgerProof(proof).ok).toBe(true);
    expect(proof.tree.anchor).toBeNull();
  });

  it("serves consistency proofs between tree heads", async () => {
    await setup();
    await agreement();
    const first = (await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body;
    await agreement();
    await agreement();
    const second = (await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body;
    const c = (
      await h.call(null, "GET", `/ledger/consistency.json?from=${first.seq}&to=${second.seq}`)
    ).body;
    expect(c.from.root).toBe(first.root);
    expect(c.to.root).toBe(second.root);
    expect(
      verifyConsistency(
        first.seq,
        second.seq,
        fromHex(first.root),
        fromHex(second.root),
        c.proof.map(fromHex),
      ),
    ).toBe(true);
    expect((await h.call(null, "GET", "/ledger/consistency.json?from=0&to=2")).status).toBe(400);
  });
});
