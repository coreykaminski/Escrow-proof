# Deploying Proof Desk (staging)

One Docker image runs two processes: **web** (the API, dashboard and public pages) and **worker** (the scheduler). Postgres holds everything. Untrusted code from deliveries never runs in either process; it runs on a separate sandbox host.

```
            ┌──────── Fly.io app "proofdesk-staging" ────────┐
 Internet ──►│ web × 1-2  (TLS at Fly; /health checked)      │──► Neon Postgres
            │ worker × 1 (tick/min, ledger check, billing)  │──► Stripe, Anthropic, Base RPC
            └───────────────────────┬────────────────────────┘
                                    │ docker CLI over SSH (DOCKER_HOST)
                             sandbox VM (Docker + gVisor), no inbound except SSH from Fly
```

## 1. One-time setup

1. **Postgres:** create a Neon project (region near `yyz`). Copy the pooled connection string.
2. **Fly:** `fly launch --no-deploy --copy-config` (the app name and region come from `fly.toml`).
3. **Secrets** (`fly secrets set …`):

| Secret | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (`postgres://…?sslmode=require`) |
| `PUBLIC_URL` | `https://proofdesk-staging.fly.dev` (or your domain) |
| `STRIPE_SECRET_KEY` | `sk_test_…` until legal sign-off |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | from step 5 |
| `REVIEWER_PAYOUT_CURRENCY` | `cad` (this Stripe account settles in CAD) |
| `ANTHROPIC_API_KEY` | enables drafting, the translation verifier and the model judges |
| `DOCKER_HOST` | `ssh://sandbox@<sandbox-vm>` (step 4) |
| `DOCKER_RUNTIME` | `runsc` once gVisor is installed |
| `CHAIN_RPC_URL`, `CHAIN_ID`, `JOBS_CONTRACT`, `EVALUATOR_PRIVATE_KEY` | stablecoin rail (step 6), optional |
| `AUTO_BILLING` | `1` to invoice and pay reviewers automatically on the 1st |

`fly.toml` already sets `NODE_ENV=production`, `MIGRATE_ON_BOOT=0`, `TRUST_PROXY=1`, `CODE_SANDBOX=docker` and `ALLOW_PRIVATE_NETWORK=0`.

4. **Sandbox host** (for code verification): a small VM (any cloud) with Docker and gVisor (`runsc`). Create a `sandbox` user in the `docker` group whose SSH key is the Fly app's (`fly ssh` → generate a key → add it to `authorized_keys`, restricted to the Fly egress IPs). Pre-pull `node:24-alpine` and `python:3.13-alpine`. Nothing else should run on it. Until it exists, code verification returns 503 and code jobs wait in `verifying`; nothing is decided on an infrastructure failure.
5. **Stripe webhook:** Dashboard → Developers → Webhooks → add `https://<PUBLIC_URL>/webhooks/stripe` for `payment_intent.*`, `charge.dispute.created` and `account.updated`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
6. **Contract (optional):** `DEPLOYER_PRIVATE_KEY=0x… PAYMENT_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e CHAIN_RPC_URL=https://sepolia.base.org npm run chain:deploy`. Fund the evaluator address with a little Base Sepolia ETH.
7. **Ledger anchoring (optional):** `ANCHORER=<anchor key address> npm run chain:deploy-anchor`, then set `ANCHOR_CONTRACT` (and `ANCHOR_PRIVATE_KEY`, or reuse the evaluator key). The worker posts the verified ledger head daily; `GET /v1/ops/ledger/anchors` checks every anchor against the database.

## 2. Deploy

```bash
fly deploy                       # builds, runs migrations (release_command), rolls web + worker
fly scale count web=1 worker=1   # exactly one worker
npx tsx apps/api/src/cli.ts create-account --name "Ops" --scopes ops     # via fly ssh console
```

## 3. Smoke test (every deploy)

1. `curl https://<PUBLIC_URL>/health` → `{"ok":true}`; `/status` shows the scheduler running within a minute.
2. Sign in to `/dashboard` with the ops key.
3. Run one agreement end to end in Stripe test mode (quickstart §2 with `createCardHold(id, { payment_method: "pm_card_visa" })`), then `POST /v1/ops/run-due` after the appeal window or force-settle.
4. `GET /v1/ops/ledger/verify` → `ok: true`.
5. Code sandbox: verify one code agreement; the case page shows the test run in the `docker` sandbox.

## 4. Operations

- **Logs:** `fly logs -a proofdesk-staging` (worker prints one JSON line per busy tick; `LEDGER CHECK FAILED` is a page-worthy alert).
- **Status:** `/status` (HTML) and `/status.json` for an uptime monitor (alert on non-200).
- **Backups:** Neon point-in-time restore (enable 7+ days). The ledger is append-only at the database level.
- **Rollback:** `fly releases` → `fly deploy --image <previous>`. Migrations are additive; don't roll back past one.
