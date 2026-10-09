/**
 * Live jobs above the direct-hold limit need a licensed escrow partner (MASTER_PLAN §1), so
 * every live funding path refuses them; test mode doesn't.
 */
import { FakeChainGateway } from "@proofdesk/chain";
import { PRICING } from "@proofdesk/core";
import { FakeGateway } from "@proofdesk/payments";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const OVER = PRICING.directHoldMaxCents + 100;

async function approved(key: string, value: number, currency: string) {
  const agr = (
    await h.call(key, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture({ amount: { value, currency } }),
    })
  ).body;
  await h.call(key, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
  return agr.id as string;
}

describe("direct-hold limit", () => {
  it("refuses live card holds and on-chain jobs over the limit, at any funding path", async () => {
    h = await createHarness({
      payments: (now) => new FakeGateway({ now, mode: "live" }),
      chain: (now) => new FakeChainGateway({ mode: "live", chainId: 8453 }, now),
    });
    const live = h.keys.live;
    await h.call(live, "PUT", "/v1/sellers/s/wallet", {
      address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    });
    const card = await approved(live, OVER, "usd");
    const hold = await h.call(live, "POST", `/v1/agreements/${card}/card-hold`, {});
    expect(hold.status).toBe(422);
    expect(hold.body.error.code).toBe("amount_requires_partner");

    const usdc = await approved(live, OVER * 10_000, "usdc");
    for (const [path, body] of [
      ["onchain-job", {}],
      ["external-job", { contract: "0x00000000000000000000000000000000000e8183", job_id: "1" }],
    ] as const) {
      const res = await h.call(live, "POST", `/v1/agreements/${usdc}/${path}`, body);
      expect(res.body.error.code).toBe("amount_requires_partner");
    }

    // At the limit, the guard lets it through (it then needs an onboarded seller).
    const atLimit = await approved(live, PRICING.directHoldMaxCents, "usd");
    const ok = await h.call(live, "POST", `/v1/agreements/${atLimit}/card-hold`, {});
    expect(ok.body.error.code).toBe("seller_not_onboarded");
  });

  it("doesn't apply in test mode", async () => {
    h = await createHarness({ chain: (now) => new FakeChainGateway(undefined, now) });
    const A = h.keys.platformA;
    await h.call(A, "PUT", "/v1/sellers/s/wallet", {
      address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    });
    const id = await approved(A, OVER * 10_000, "usdc");
    expect((await h.call(A, "POST", `/v1/agreements/${id}/onchain-job`, {})).status).toBe(201);
  });
});
