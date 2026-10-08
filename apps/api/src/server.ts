import { serve } from "@hono/node-server";
import { createDb } from "@proofdesk/db";
import { createApp } from "./app.ts";
import { loadEnv } from "./load-env.ts";
import {
  allowPrivateNetworkFromEnv,
  anchorFromEnv,
  chainFromEnv,
  codeVerifierFromEnv,
  dataVerifierFromEnv,
  drafterFromEnv,
  paymentsFromEnv,
  reviewerRatesFromEnv,
  verifierFromEnv,
} from "./models.ts";

loadEnv();

const databaseUrl = process.env.DATABASE_URL ?? "pglite:./.data/dev";
const port = Number(process.env.PORT ?? 8787);

const handle = createDb(databaseUrl);
// In production, migrations run once per deploy (fly.toml release_command), not on every boot.
if (process.env.MIGRATE_ON_BOOT !== "0") await handle.migrate();

const drafter = drafterFromEnv();
const verifier = verifierFromEnv();
if (!drafter) console.warn("ANTHROPIC_API_KEY not set: drafting and verification will return 503.");
const payments = paymentsFromEnv();
if (!payments)
  console.warn("STRIPE_SECRET_KEY not set: card funding and card settlement will return 503.");
const chain = chainFromEnv();
if (!chain)
  console.warn(
    "CHAIN_RPC_URL/JOBS_CONTRACT/EVALUATOR_PRIVATE_KEY not set: on-chain funding will return 503.",
  );
const app = createApp({
  db: handle.db,
  now: () => new Date(),
  drafter,
  verifier,
  codeVerifier: codeVerifierFromEnv(),
  allowPrivateNetwork: allowPrivateNetworkFromEnv(),
  reviewerRates: reviewerRatesFromEnv(),
  trustProxy: process.env.TRUST_PROXY === "1" || Boolean(process.env.FLY_APP_NAME),
  dataVerifier: dataVerifierFromEnv(),
  ...(payments ? { payments } : {}),
  ...(chain ? { chain } : {}),
  ...(anchorFromEnv() ? { anchor: anchorFromEnv() } : {}),
  ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
  ...(process.env.STRIPE_PUBLISHABLE_KEY
    ? { stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY }
    : {}),
});
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Proof Desk API listening on http://localhost:${info.port} (${handle.driver})`);
});

async function shutdown() {
  server.close();
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
