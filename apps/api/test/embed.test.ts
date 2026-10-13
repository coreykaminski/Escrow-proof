/** The embeddable verdict widget: framable only where intended, nothing private shown. */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function decidedWithLink() {
  const A = h.keys.platformA;
  const agr = (
    await h.call(A, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    })
  ).body;
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [{ name: "out.txt", media_type: "text/plain", content: "PRIVATE DELIVERABLE TEXT" }],
  });
  await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/start-verification`);
  await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/decide`, {
    outcome: { kind: "partial", release_percent: 60 },
    reason: "One clause missing.",
  });
  return (await h.call(A, "POST", `/v1/agreements/${agr.id}/report-links`, {})).body;
}

describe("verdict widget", () => {
  it("returns a drop-in snippet with the report link", async () => {
    h = await createHarness();
    const link = await decidedWithLink();
    const token = link.url.split("/r/")[1];
    expect(link.embed.iframe_url).toBe(`http://localhost/embed/r/${token}`);
    expect(link.embed.html).toContain('<script src="http://localhost/embed/v1.js" async></script>');
    expect(link.embed.html).toContain(`data-proofdesk-verdict="${token}"`);
  });

  it("renders a compact verdict that any site may frame, and nothing private", async () => {
    h = await createHarness();
    const link = await decidedWithLink();
    const res = await h.fetch(`${link.embed.iframe_url}?theme=dark`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Translate NDA EN→ES");
    expect(html).toContain("Partly passed: 60% paid");
    expect(html).toContain("Decided by a human reviewer");
    expect(html).toContain('class="dark"');
    expect(html).not.toContain("PRIVATE DELIVERABLE TEXT");

    // Every other page still refuses to be framed.
    const report = await h.fetch(link.url);
    expect(report.headers.get("x-frame-options")).toBe("DENY");
    expect(report.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("says so when the link expired, and serves the loader script cross-origin", async () => {
    h = await createHarness();
    const gone = await h.fetch("http://x/embed/r/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("This verdict link has expired");
    const js = await h.fetch("http://x/embed/v1.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(await js.text()).toContain("data-proofdesk-verdict");
  });
});
