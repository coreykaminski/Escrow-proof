# Proof Desk

Conditional payments + verification for agent purchases: money is held, the deliverable is
checked against the approved spec, then released or refunded. Every decision goes on a
tamper-evident ledger. See [MASTER_PLAN.md](MASTER_PLAN.md) for the strategy and build plan.

**Status:** Part 1 (Foundation) is done. Verification is driven manually through ops endpoints
until Part 3; only the `test` payment rail exists until Part 4.

## Quickstart

```bash
npm install
npm run check                                   # lint + typecheck + tests

npm run cli -- create-account --name "My Platform"        # prints a platform API key
npm run cli -- create-account --name "Ops" --ops          # prints an ops API key
npm run dev                                     # API on http://localhost:8787
```

No Docker needed. By default the database is embedded Postgres (PGlite) in `./.data/dev`.
Set `DATABASE_URL=postgres://…` to use a real server.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure domain logic: spec schema + hashing, agreement state machine, ledger hash chain, canonical JSON, ids. No I/O. |
| `packages/db` | Drizzle schema, migrations (`drizzle/`), DB client (PGlite or Postgres), ledger append/verify. |
| `apps/api` | Hono HTTP API, API-key auth, idempotency, agreement service, CLI. |

## Key design rules

- **One way to change state:** `applyEvent()` in `apps/api/src/services/agreements.ts` locks the
  row, runs the pure `transition()` from core, writes the change and a ledger entry in **one
  transaction**. Never update `agreements.status` anywhere else.
- **Ledger is append-only twice over:** DB triggers block UPDATE/DELETE/TRUNCATE, and the hash
  chain (`verify-ledger`) catches anyone who bypasses them.
- **Spec approval is hash-bound:** the buyer approves a specific `spec_hash`; an edited spec
  won't match. The spec is snake_case because it's the exact document that gets approved and hashed.
- **Money amounts** are integer minor units. **Times** come from the injected clock (`deps.now`).
- **Schema changes:** edit `packages/db/src/schema.ts`, then `npm run db:generate`. Raw SQL
  (triggers etc.) goes in a custom migration (`npx drizzle-kit generate --custom` in `packages/db`).

## API (v1)

All routes need `Authorization: Bearer pd_test_…`. POST/PUT accept an `Idempotency-Key` header.

**Platform** (scope `platform`, own agreements only):

| Method | Path | Actor |
|---|---|---|
| POST | `/v1/agreements` | create (draft) |
| GET | `/v1/agreements?status=&limit=` | list |
| GET | `/v1/agreements/:id` | |
| PUT | `/v1/agreements/:id/spec` | replace spec (draft only) |
| POST | `/v1/agreements/:id/approve-spec` `{spec_hash}` | buyer |
| POST | `/v1/agreements/:id/cancel` `{actor, reason}` | buyer/seller |
| POST | `/v1/agreements/:id/fund` `{rail:"test", hold_ref}` | buyer |
| POST | `/v1/agreements/:id/deliveries` `{artifacts[]}` | seller |
| GET | `/v1/agreements/:id/deliveries?include_content=true` | |
| POST | `/v1/agreements/:id/disputes` `{opened_by, reason}` | losing party |
| GET | `/v1/agreements/:id/ledger` | |

**Ops** (scope `ops`, any agreement): `start-verification`, `decide`, `miss-deadline`,
`resolve-dispute`, `settle` under `/v1/ops/agreements/:id/…`, plus `GET /v1/ops/ledger/verify`.

### Lifecycle

```
draft → spec_approved → funded → delivered → verifying → (escalated →) decided → settled
          cancel ↘          ↘ missed deadline → decided (refund)        ↕ dispute (once)
```
