/**
 * Card rail against real Stripe *test mode* (no money moves). Verifies what FakeGateway can only
 * simulate: holds, extended authorization requests, full/partial capture, cancel, idempotent
 * replays, and (optionally) a transfer to an onboarded connected account.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:e2e
 *   STRIPE_E2E_DESTINATION=acct_...   # optional: an onboarded test connected account for transfers
 */
import { StripeGateway } from "@proofdesk/payments";
import { loadEnv } from "../apps/api/src/load-env.ts";

loadEnv();
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
  console.error(
    "Set STRIPE_SECRET_KEY to a TEST-mode key (sk_test_…). Refusing to run against live.",
  );
  process.exit(1);
}
const gw = new StripeGateway({ secretKey: key });
const run = `e2e_${Date.now()}`;
let failures = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const hold = (id: string, extended = false) =>
  gw.createHold({
    amount: 18_000,
    currency: "usd",
    agreementId: `${run}_${id}`,
    description: `Proof Desk e2e ${id}`,
    paymentMethod: "pm_card_visa",
    extendedAuthorization: extended,
    idempotencyKey: `${run}:hold:${id}`,
  });

await check("hold authorizes with a capture deadline", async () => {
  const h = await hold("auth");
  expect(h.status === "requires_capture", `status ${h.status}`);
  expect(h.amount_capturable === 18_000, `capturable ${h.amount_capturable}`);
  expect(h.capture_before && h.capture_before > new Date(), "no capture_before");
});

await check("replaying the same idempotency key returns the same hold", async () => {
  const [a, b] = [await hold("idem"), await hold("idem")];
  expect(a.id === b.id, `${a.id} != ${b.id}`);
});

await check("extended authorization can be requested", async () => {
  const h = await hold("extended", true);
  expect(h.status === "requires_capture", `status ${h.status}`);
  console.log(
    `    extended granted: ${h.extended}, capture_before: ${h.capture_before?.toISOString()}`,
  );
});

await check("full capture, replay-safe", async () => {
  const h = await hold("capture");
  const c1 = await gw.capture(h.id, 18_000, `${run}:cap:full`);
  const c2 = await gw.capture(h.id, 18_000, `${run}:cap:full`);
  expect(c1.status === "succeeded" && c1.amount_received === 18_000, `status ${c1.status}`);
  expect(c2.amount_received === 18_000, "replay changed the result");
});

await check("partial capture releases the rest of the authorization", async () => {
  const h = await hold("partial");
  const c = await gw.capture(h.id, 7_200, `${run}:cap:partial`);
  expect(c.amount_received === 7_200, `received ${c.amount_received}`);
});

await check("cancel releases the hold without charging", async () => {
  const h = await hold("cancel");
  const c = await gw.cancel(h.id, `${run}:cancel`);
  expect(c.status === "canceled" && c.amount_received === 0, `status ${c.status}`);
});

await check("refund after capture", async () => {
  const h = await hold("refund");
  await gw.capture(h.id, 18_000, `${run}:cap:refund`);
  const r = await gw.refund({ holdId: h.id, amount: 18_000, idempotencyKey: `${run}:refund` });
  expect(r.id.startsWith("re_"), r.id);
});

const destination = process.env.STRIPE_E2E_DESTINATION;
if (destination) {
  await check("transfer to the seller's connected account", async () => {
    const h = await hold("transfer");
    const c = await gw.capture(h.id, 18_000, `${run}:cap:transfer`);
    const t = await gw.transfer({
      amount: 17_640,
      currency: "usd",
      destination,
      agreementId: `${run}_transfer`,
      sourceCharge: c.charge_id ?? "",
      idempotencyKey: `${run}:transfer`,
    });
    expect(t.id.startsWith("tr_"), t.id);
  });
} else {
  console.log(
    "- transfer skipped (set STRIPE_E2E_DESTINATION to an onboarded test connected account)",
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll Stripe test-mode checks passed.");
process.exitCode = failures ? 1 : 0;
