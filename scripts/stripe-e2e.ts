/**
 * Card rail against real Stripe *test mode* (no money moves). Verifies what FakeGateway can only
 * simulate: holds, extended authorization requests, full/partial capture, cancel, idempotent
 * replays, and (optionally) a transfer to an onboarded connected account.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:e2e
 *   STRIPE_E2E_DESTINATION=acct_...   # optional: an onboarded test connected account for transfers
 */
import { SPT_API_VERSION, StripeGateway } from "@proofdesk/payments";
import Stripe from "stripe";
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

await check(
  "a long job's hold is placed even if extended authorization isn't available",
  async () => {
    const h = await hold("extended", true);
    expect(h.status === "requires_capture", `status ${h.status}`);
    console.log(
      `    extended granted: ${h.extended} (if false, the scheduler captures before ${h.capture_before?.toISOString()})`,
    );
  },
);

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

await check("an agent's shared payment token (MPP/ACP) funds a hold", async () => {
  const stripe = new Stripe(key);
  const granted = (await stripe.rawRequest(
    "POST",
    "/v1/test_helpers/shared_payment/granted_tokens",
    {
      payment_method: "pm_card_visa",
      "usage_limits[currency]": "usd",
      "usage_limits[max_amount]": 18_000,
      "usage_limits[expires_at]": Math.floor(Date.now() / 1000) + 3_600,
    } as never,
    { apiVersion: SPT_API_VERSION },
  )) as unknown as { id: string };
  const token = await gw.getSharedPaymentToken(granted.id);
  expect(token.active && token.max_amount === 18_000 && token.currency === "usd", "token limits");
  const h = await gw.createHold({
    amount: 18_000,
    currency: "usd",
    agreementId: `${run}_spt`,
    description: "Proof Desk e2e spt",
    sharedPaymentToken: granted.id,
    extendedAuthorization: false,
    idempotencyKey: `${run}:hold:spt`,
  });
  expect(h.status === "requires_capture", `status ${h.status}`);
  await gw.cancel(h.id, `${run}:cancel:spt`);
  console.log(
    `    ${granted.id} → ${h.id}, card ${token.card?.brand ?? "?"} ${token.card?.last4 ?? ""}`,
  );
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
    console.log(`    paid ${t.amount} ${t.currency} (charge was 18000 usd)`);
  });
} else {
  console.log(
    "- transfer skipped (set STRIPE_E2E_DESTINATION to an onboarded test connected account)",
  );
}

await check("seller account (Accounts v2) and hosted onboarding link", async () => {
  const seller = await gw.createSellerAccount({
    sellerRef: `${run}_seller`,
    country: "us",
    email: "seller-e2e@example.com",
    idempotencyKey: `${run}:seller`,
  });
  expect(seller.id.startsWith("acct_"), seller.id);
  const link = await gw.createOnboardingLink({
    accountId: seller.id,
    refreshUrl: "https://example.com/refresh",
    returnUrl: "https://example.com/done",
  });
  expect(link.url.startsWith("https://"), link.url);
  const fresh = await gw.getSellerAccount(seller.id);
  console.log(
    `    ${seller.id}: onboarding pending (details_submitted=${fresh.details_submitted}, payouts ready=${fresh.transfers_active})`,
  );
});

await check("billing: customer + invoice with lines, finalized and sent", async () => {
  const customer = await gw.createCustomer({
    accountId: `${run}_platform`,
    name: "E2E Platform",
    email: "billing-e2e@example.com",
    idempotencyKey: `${run}:customer`,
  });
  expect(customer.id.startsWith("cus_"), customer.id);
  const lines = [
    { description: "Verification: translation × 3 @ $1.50", amount: 450 },
    { description: "Dispute resolution (losing party: buyer)", amount: 2_500 },
  ];
  const inv = await gw.createInvoice({
    customerId: customer.id,
    currency: "usd",
    period: "2026-10",
    lines,
    daysUntilDue: 14,
    idempotencyKey: `${run}:invoice`,
  });
  expect(inv.total === 2_950, `total ${inv.total}`);
  expect(inv.status === "open", `status ${inv.status}`);
  expect(inv.hostedUrl?.startsWith("https://"), "no hosted invoice URL");
  const again = await gw.createInvoice({
    customerId: customer.id,
    currency: "usd",
    period: "2026-10",
    lines,
    daysUntilDue: 14,
    idempotencyKey: `${run}:invoice`,
  });
  expect(again.id === inv.id, "a retried run created a second invoice");
  console.log(`    ${inv.id}: ${inv.total} usd, ${inv.status}`);
});

if (destination) {
  await check("reviewer payout: transfer from the platform balance", async () => {
    // Make funds available right away (Stripe's bypass-pending test card), then pay out.
    const topUp = await gw.createHold({
      amount: 2_000,
      currency: "usd",
      agreementId: `${run}_topup`,
      description: "Proof Desk e2e balance top-up",
      paymentMethod: "pm_card_bypassPending",
      extendedAuthorization: false,
      idempotencyKey: `${run}:topup`,
    });
    await gw.capture(topUp.id, 2_000, `${run}:topup:capture`);
    try {
      const t = await gw.payout({
        amount: 100,
        currency: process.env.REVIEWER_PAYOUT_CURRENCY ?? "usd",
        destination,
        description: "Proof Desk reviews e2e",
        idempotencyKey: `${run}:payout`,
      });
      expect(t.id.startsWith("tr_"), t.id);
      console.log(`    paid ${t.amount} ${t.currency}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/insufficient|balance/i.test(msg)) {
        console.log(`    skipped: test balance has no available funds (${msg.slice(0, 120)})`);
        return;
      }
      throw err;
    }
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll Stripe test-mode checks passed.");
process.exitCode = failures ? 1 : 0;
