/** Part 10: anchoring the ledger head on-chain, and checking anchors against the ledger. */
import { FakeAnchorGateway } from "@proofdesk/chain";
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

    const first = (await h.call(O(), "POST", "/v1/ops/ledger/anchor")).body;
    expect(first).toMatchObject({ status: "anchored", seq: head.seq, head_hash: head.entry_hash });
    expect(anchor.anchors).toEqual([
      expect.objectContaining({ seq: head.seq, headHash: head.entry_hash }),
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
      problem: "hash differs from the anchor",
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
