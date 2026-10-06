# Proof Desk

Conditional payments + verification for agent purchases: money is held, the deliverable is
checked against the approved spec, then released or refunded. Every decision goes on a
tamper-evident ledger. See [MASTER_PLAN.md](MASTER_PLAN.md) for the strategy and build plan.

**Status:** Part 1 (Foundation) and Part 2 (Spec Engine) are built. Part 2's eval passed its gate:
50/50 valid specs, 96.8% of criteria rated testable (AI-rated; see docs/daily/2026-10-06.md). Part 3 (translation verifier) is built
and wired in; its accuracy gate needs the model-based eval run (see below). Only the `test`
payment rail exists until Part 4.

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
| `packages/verifier` | Translation verifier: deterministic checks (values, structure, language, injection), MQM annotator + criterion judge, ensemble and decision policy. |
| `apps/api` | Hono HTTP API, API-key auth, idempotency, agreement service, CLI. |
| `evals/spec-engine` | 50 sample requests, eval runner and human-rating scorer for the Part 2 gate. |
| `evals/translation` | Golden set (300 labelled translation items) builders, deterministic CI gate, model eval harness. |

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
| POST | `/v1/agreements/:id/fund` `{rail:"test", hold_ref}` | buyer |
| POST | `/v1/agreements/:id/deliveries` `{artifacts[]}` | seller |
| GET | `/v1/agreements/:id/deliveries?include_content=true` | |
| POST | `/v1/agreements/:id/disputes` `{opened_by, reason}` | losing party |
| PUT | `/v1/agreements/:id/inputs` `{inputs[]}` | source material (draft only; hashed into the spec) |
| GET | `/v1/agreements/:id/inputs?include_content=true` | |
| GET | `/v1/agreements/:id/verifications` | verifier reports |
| GET | `/v1/agreements/:id/ledger` | |

Agreements include `spec_source` (manual, or drafted with model, prompt version, open questions
and any AP2 mandate hash) and `spec_warnings` (advisory lint for vague or unverifiable criteria).
Drafting errors: `422 spec_draft_refused`, `502 spec_draft_failed|spec_draft_invalid`,
`503 spec_engine_unavailable` (retryable; 5xx responses aren't stored under an Idempotency-Key).

**Ops** (scope `ops`, any agreement): `verify` (runs the automated verifier on the latest
delivery, then decides or escalates), `start-verification`, `decide`, `miss-deadline`,
`resolve-dispute`, `settle` under `/v1/ops/agreements/:id/…`, plus `GET /v1/ops/ledger/verify`.

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

### Lifecycle

```
draft → spec_approved → funded → delivered → verifying → (escalated →) decided → settled
          cancel ↘          ↘ missed deadline → decided (refund)        ↕ dispute (once)
```
