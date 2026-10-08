import { billingPeriod } from "@proofdesk/core";
import { createDb } from "@proofdesk/db";
import { loadEnv } from "./load-env.ts";
import {
  allowPrivateNetworkFromEnv,
  anchorFromEnv,
  chainFromEnv,
  paymentsFromEnv,
  reviewerRatesFromEnv,
} from "./models.ts";
import { anchorLedger } from "./services/anchoring.ts";
import { invoicePeriod, payReviewers } from "./services/billing.ts";
import { tick } from "./services/scheduler.ts";
import { checkLedger, getState, setState } from "./services/status.ts";

/**
 * The background worker: one scheduler tick a minute (deadlines, settlements, early capture,
 * on-chain expiry, webhooks), a full ledger re-verification every few hours, and, with
 * AUTO_BILLING=1, last month's invoices and reviewer payouts early on the 1st.
 * Every step is idempotent, so a crash or an overlapping run is safe. Run one instance.
 */
loadEnv();
const handle = createDb(process.env.DATABASE_URL ?? "pglite:./.data/dev");
const db = handle.db;
const payments = paymentsFromEnv();
const chain = chainFromEnv();
const allowPrivateNetwork = allowPrivateNetworkFromEnv();
const TICK_MS = Number(process.env.TICK_INTERVAL_S ?? 60) * 1000;
const LEDGER_MS = Number(process.env.LEDGER_CHECK_INTERVAL_H ?? 6) * 3_600_000;
const ANCHOR_MS = Number(process.env.ANCHOR_INTERVAL_H ?? 24) * 3_600_000;
const anchor = anchorFromEnv();

const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    stop.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

async function monthlyBilling(now: Date) {
  if (process.env.AUTO_BILLING !== "1" || !payments) return;
  if (now.getUTCDate() !== 1 || now.getUTCHours() < 2) return;
  const prev = billingPeriod(new Date(now.getTime() - 86_400_000));
  const key = `billing.${prev}`;
  if ((await getState(db, key))?.value.done) return;
  const invoices = await invoicePeriod(db, payments, { period: prev, now });
  const payouts = await payReviewers(db, payments, {
    period: prev,
    now,
    rates: reviewerRatesFromEnv(),
  });
  await setState(
    db,
    key,
    { done: true, invoices: invoices.invoiced.length, payouts: payouts.paid.length },
    now,
  );
  console.log(
    `billing ${prev}: ${invoices.invoiced.length} invoices, ${payouts.paid.length} payouts`,
  );
}

console.log(
  `worker: tick every ${TICK_MS / 1000}s; card ${payments ? payments.mode : "off"}; chain ${chain ? "on" : "off"}`,
);
let lastLedgerCheck = 0;
let lastAnchor = 0;
while (!stop.signal.aborted) {
  const now = new Date();
  try {
    const r = await tick(db, { payments, chain, allowPrivateNetwork }, now);
    const busy =
      r.settled.length +
      r.deadlines_missed.length +
      r.captured_early.length +
      r.errors.length +
      r.onchain_expired.length +
      r.webhooks.delivered;
    if (busy > 0) {
      console.log(
        JSON.stringify({
          at: now.toISOString(),
          settled: r.settled.length,
          deadlines_missed: r.deadlines_missed.length,
          captured_early: r.captured_early.length,
          onchain_expired: r.onchain_expired.length,
          webhooks: r.webhooks.delivered,
          errors: r.errors,
        }),
      );
    }
    if (Date.now() - lastLedgerCheck > LEDGER_MS) {
      const result = await checkLedger(db, now);
      lastLedgerCheck = Date.now();
      if (!result.ok) console.error(`LEDGER CHECK FAILED at seq ${result.seq}: ${result.reason}`);
    }
    if (anchor && Date.now() - lastAnchor > ANCHOR_MS) {
      const a = await anchorLedger(db, anchor, now);
      lastAnchor = Date.now();
      if (a.status === "anchored") console.log(`ledger anchored at seq ${a.seq}: ${a.tx_hash}`);
    }
    await monthlyBilling(now);
  } catch (err) {
    console.error("tick failed", err);
  }
  if (!stop.signal.aborted) await sleep(TICK_MS);
}
await handle.close();
console.log("worker stopped");
