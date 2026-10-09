# Proof Desk

Conditional payments + verification for agent purchases: money is held, the deliverable is
checked against the approved spec, then released or refunded. Every decision goes on a
tamper-evident ledger. See [MASTER_PLAN.md](MASTER_PLAN.md) for the strategy and build plan.

**New here? Start with the [quickstart](docs/quickstart.md)** (sandbox, ~15 minutes). The API
reference is served at `/docs` (OpenAPI at `/openapi.json`).

**Status:** Parts 1–9 and the engineering parts of 10 are built and tested (658 Vitest tests,
25 Foundry tests, golden-set gates in CI):

- **Spec Engine (2):** its eval passed (AI-rated).
- **Verifiers (3, 8):**
  - Translation needs its model eval (Anthropic credits).
  - Code (sandboxed tests) and data/research (schemas, citations, quotes) meet every §6 target
    on their free layers; their model judges are measured with credits.
- **Card rail (4):** passes live Stripe test mode (`npm run stripe:e2e`).
- **Developer surface (5)** and **dashboard (6)** are built.
- **Stablecoin rail (7):** an ERC-8183 contract with invariants, gasless USDC funding and x402.
  Passes on a local chain; Base Sepolia needs keys.
- **Billing and hardening (9):** Stripe Billing invoices and reviewer payouts (live test mode
  passes), rate limits, CSP, SSRF guards, status and pricing pages, worker, Fly config.
- **Scale (10):**
  - On-chain ledger anchoring and a public accuracy report.
  - Pilot shadow mode: a human confirms every automatic decision before money moves.
  - Evaluator-for-hire on any ERC-8183 contract
    ([docs/integrations/erc8183-evaluator.md](docs/integrations/erc8183-evaluator.md)).

Still open: the model evals and the go-live gates (lawyer, pen test, contract audit). See
[docs/launch/runbook.md](docs/launch/runbook.md).

## Quickstart

```bash
npm install
npm run check                                   # lint + typecheck + tests

npm run cli -- create-account --name "My Platform"        # prints a platform API key
npm run cli -- create-account --name "Ops" --ops          # prints an ops API key
npm run dev                                     # API on http://localhost:8787

npm run cli -- draft-spec --request "Translate my NDA into Spanish"   # try the Spec Engine
```

No Docker needed. By default the database is embedded Postgres (PGlite) in `./.data/dev`.
Set `DATABASE_URL=postgres://…` to use a real server. The server and CLI read `./.env`
(see `.env.example`); `ANTHROPIC_API_KEY` enables spec drafting.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure domain logic: spec schema + hashing, agreement state machine, ledger hash chain, canonical JSON, ids. No I/O. |
| `packages/db` | Drizzle schema, migrations (`drizzle/`), DB client (PGlite or Postgres), ledger append/verify. |
| `packages/spec-engine` | Request → drafted criteria (Claude, structured output), spec assembly, AP2 mandate import. |
| `packages/verifier` | Verifiers and the shared decision policy. Translation: deterministic checks, MQM annotator + judge. Code: sandboxes (Docker, Node permission model), trusted signed test runner, judge. Data/research: JSON Schema, counts, duplicates, SSRF-safe citation and quote checks, judge. |
| `packages/chain` | Stablecoin rail: viem gateway for the ProofDeskJobs contract and any ERC-8183 contract, in-memory fake, generated ABI. |
| `contracts` | Foundry project: `ProofDeskJobs.sol` (ERC-8183 job escrow, Proof Desk as evaluator only), unit/fuzz/invariant tests, deploy script. |
| `packages/payments` | Card rail: Stripe gateway (Connect Express, manual-capture holds, transfers, webhooks), settlement planning and fees, an in-memory Stripe simulator for tests. |
| `packages/sdk` | `@proofdesk/sdk`: typed TypeScript client (auto idempotency keys, retries) and webhook signature verification. No dependencies. |
| `apps/api` | Hono HTTP API, API-key auth, idempotency, agreement service, outbound webhooks, OpenAPI, CLI. |
| `apps/mcp` | MCP server so AI agents can create, fund and track protected purchases (`create_protected_purchase` …). |
| `examples` | The quickstart as a runnable script. |
| `evals/spec-engine` | 50 sample requests, eval runner and human-rating scorer for the Part 2 gate. |
| `evals/translation` | Golden set (300 labelled translation items) builders, deterministic CI gate, model eval harness. |
| `evals/code`, `evals/data` | Golden sets (130 code, 50 data/research items, attacks included), CI gates, eval runners (`--judge` for the model layer). |
| `docs/` | Quickstart, deploy guide, security review, red-team catalog, SOC 2 readiness, launch runbook, daily logs. |

## Key design rules

- **One way to change state:** `applyEvent()` in `apps/api/src/services/agreements.ts` locks the
  row, runs the pure `transition()` from core, writes the change and a ledger entry in **one
  transaction**. Never update `agreements.status` anywhere else.
- **Ledger is append-only twice over:** DB triggers block UPDATE/DELETE/TRUNCATE, and the hash
  chain (`verify-ledger`) catches anyone who bypasses them.
- **Spec approval is hash-bound:** the buyer approves a specific `spec_hash`; an edited spec
  won't match. The spec is snake_case because it's the exact document that gets approved and hashed.
- **The model never sets money terms:** the Spec Engine drafts only title, vertical and criteria.
  Amount, currency, deadline and appeal window always come from the caller (or a cart mandate).
  The buyer's request is wrapped as untrusted data in the prompt.
- **Money amounts** are integer minor units. **Times** come from the injected clock (`deps.now`).
- **Schema changes:** edit `packages/db/src/schema.ts`, then `npm run db:generate`. Raw SQL
  (triggers etc.) goes in a custom migration (`npx drizzle-kit generate --custom` in `packages/db`).

## API (v1)

All routes need `Authorization: Bearer pd_test_…`. POST/PUT accept an `Idempotency-Key` header.

**Platform** (scope `platform`, own agreements only):

| Method | Path | Actor |
|---|---|---|
| POST | `/v1/agreements` | create (draft) with a spec you wrote |
| POST | `/v1/agreements/from-request` `{request, amount, delivery_due_at, …}` | create (draft) with Claude-drafted criteria |
| POST | `/v1/agreements/from-mandate` `{mandate_type, mandate, delivery_due_at, …}` | same, from an AP2 intent/cart mandate |
| GET | `/v1/agreements?status=&limit=` | list |
| GET | `/v1/agreements/:id` | |
| PUT | `/v1/agreements/:id/spec` | replace spec (draft only) |
| POST | `/v1/agreements/:id/approve-spec` `{spec_hash}` | buyer |
| POST | `/v1/agreements/:id/cancel` `{actor, reason}` | buyer/seller |
| POST | `/v1/agreements/:id/card-hold` `{payment_method?}` | buyer: authorize the card (returns client_secret) |
| GET | `/v1/agreements/:id/hold` | card hold status and settlement |
| POST | `/v1/agreements/:id/fund` `{rail:"test", hold_ref}` | buyer (test rail) |
| POST | `/v1/agreements/:id/deliveries` `{artifacts[]}` | seller |
| GET | `/v1/agreements/:id/deliveries?include_content=true` | |
| POST | `/v1/agreements/:id/disputes` `{opened_by, reason}` | losing party |
| PUT | `/v1/agreements/:id/inputs` `{inputs[]}` | source material (draft only; hashed into the spec) |
| GET | `/v1/agreements/:id/inputs?include_content=true` | |
| GET | `/v1/agreements/:id/verifications` | verifier reports |
| GET | `/v1/agreements/:id/ledger` | |

**Sellers:** `POST /v1/sellers/:seller_ref/onboarding` `{email, country}` creates the seller's
Stripe Connect account (Accounts v2, Express dashboard) and returns a hosted onboarding link; `GET /v1/sellers/:seller_ref` shows whether
payouts are ready. **Webhooks:** `POST /webhooks/stripe` (signature-verified, processed once).

Agreements include `spec_source` (manual, or drafted with model, prompt version, open questions
and any AP2 mandate hash) and `spec_warnings` (advisory lint for vague or unverifiable criteria).
Drafting errors: `422 spec_draft_refused`, `502 spec_draft_failed|spec_draft_invalid`,
`503 spec_engine_unavailable` (retryable; 5xx responses aren't stored under an Idempotency-Key).

**Ops** (scope `ops`, any agreement): `verify` (runs the automated verifier on the latest
delivery, then decides or escalates), `start-verification`, `decide`, `miss-deadline`,
`resolve-dispute`, `settle` (card: moves the money) under `/v1/ops/agreements/:id/…`, plus
`POST /v1/ops/run-due` (scheduler tick, also `npm run cli -- run-due`) and `GET /v1/ops/ledger/verify`.

### Spec Engine eval

```bash
npm run eval:spec -- --limit 5          # drafts sample requests (calls Claude; a few cents per request)
npm run eval:spec                       # all 50 → evals/spec-engine/runs/<timestamp>/
npm run eval:spec:score -- evals/spec-engine/runs/<timestamp>/review.csv
```

Rate each criterion in `review.csv` (`testable` = y/n) before scoring. The gate is ≥90% testable.

### Translation verifier

Cheapest layer first: deterministic checks (numbers and dates normalized across en/es/fr/de,
paragraph structure, untranslated text, text aimed at the verifier). A high-confidence critical
finding refunds on its own, with no model call. Otherwise an MQM annotator (`claude-opus-5-5`)
and a per-criterion judge (`claude-sonnet-5-5`) run in parallel. Quoted evidence must exist in
the texts, both must agree to auto-decide, and anything else escalates to a human.

```bash
npm run golden:base && npm run golden:corrupt && npm run golden:build   # rebuild the golden set (calls Claude)
npm run eval:translation -- --sample 60     # model-based eval on a stratified sample (calls Claude)
npm run eval:translation                    # all 300; checks the MASTER_PLAN §6 targets
```

The deterministic gate on the golden set runs with `npm test` (free). The full eval also runs from
GitHub Actions → "Translation verifier eval" (needs the `ANTHROPIC_API_KEY` repo secret).

### Dashboard and human review

`/dashboard`: sign in with an API key, which gives an HttpOnly session cookie, and every form carries a
CSRF token.
- **Platform keys:** your agreements, each with its criteria, verdicts and evidence, the source and the
  delivered documents side by side, the card hold, and the ledger.
- **Ops keys** (one per reviewer: `npm run cli -- create-account --name "Reviewer Jane" --ops`)
  also get the **review queue** (escalated or disputed, oldest first), a decision form (a decision on an
  escalation, or a final dispute resolution), and **reviewer stats** for payouts.

Shareable links (random tokens, stored hashed, expiring):
- `POST /v1/agreements/:id/report-links` → `/r/…`: a public **verdict report** with the criteria,
  verdicts, decision, spec/delivery/report hashes and the ledger with a chain check. It never shows the
  documents themselves.
- `POST /v1/agreements/:id/payment-links` → `/pay/…`: a hosted page where the buyer authorizes
  their card with Stripe.js. It needs `STRIPE_PUBLISHABLE_KEY`.

### Card rail (Stripe)

Proof Desk never holds funds itself. A card **authorization hold** (PaymentIntent, manual
capture) stays on the buyer's card until the decision is final, i.e. after the appeal window:

| Outcome | Money movement |
|---|---|
| release | capture the hold, transfer amount minus the 2% fee (min $0.50, cap $250) to the seller's connected account |
| refund | cancel the hold: nothing is charged, no refund fee, no chargeback exposure |
| partial | capture only the released share, transfer it minus the fee; the rest of the authorization lapses |

Authorizations last ~7 days (~30 with extended authorization, requested for longer jobs). The
scheduler captures any hold within 24 h of lapsing before its agreement settles; a later refund
then refunds the captured funds. Settlement checks eligibility before touching money and gives
every Stripe call a stable idempotency key, so a retry after a crash finishes without repeating
a capture or transfer. Open chargebacks block payout. Payouts go out in the currency the charge
settled in (e.g. CAD on a Canadian platform), converted at the rate Stripe applied to that charge.

### Lifecycle

```
draft → spec_approved → funded → delivered → verifying → (escalated →) decided → settled
          cancel ↘          ↘ missed deadline → decided (refund)        ↕ dispute (once)
```
