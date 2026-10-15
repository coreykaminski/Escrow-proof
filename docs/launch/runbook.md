# Design-partner go-live runbook

## Before the first partner touches it
- [ ] Staging deployed per docs/deploy.md; smoke test green.
- [ ] Code sandbox host running with gVisor; one code job verified through it.
- [ ] `/status.json` watched by an uptime monitor that pages Corey, and `ALERT_WEBHOOK_URL` set (server errors, worker failures, a failed ledger check).
- [ ] Ops keys: one per human reviewer; each reviewer has finished payout onboarding (`POST /v1/ops/reviewers/me/onboarding`).
- [ ] Model evals run (needs Anthropic credits): `npm run eval:translation`, `eval:code -- --judge`, `eval:data -- --judge`. Every §6 target met, or those decision types set to escalate. Then `npm run evals:publish` and commit, so `/accuracy` shows the new numbers.

## Before real money (live keys)
- [ ] **Fintech lawyer sign-off** on the card flow, the stablecoin flow, wording ("conditional payment", never "escrow"), CA platform with US buyers (docs/validation/lawyer-brief.md).
- [ ] Stripe live mode activated; live webhook endpoint and secret set; `STRIPE_EXTENDED_AUTH` only if Stripe enabled it.
- [ ] Third-party pen test, findings fixed (brief them with docs/security/audit-pack.md, Part B).
- [ ] Contract audit booked before any mainnet deployment (send docs/security/audit-pack.md, Part A); evaluator, relayer and anchorer each on their own KMS key; owner is a multisig (docs/security/evaluator-keys.md, enforced at startup and in the deploy scripts).
- [ ] Retention period agreed with the lawyer and stated in the privacy policy (`RETENTION_DAYS`, default 90 days after an agreement is final; per-partner override `PUT /v1/ops/accounts/:id/retention`; on-request deletion `DELETE /v1/agreements/:id/content`).
- [ ] Terms of service and privacy policy published; the pricing page matches the contract with each partner.
- [ ] Lawyer confirms the $5,000 direct-hold limit (`PRICING.directHoldMaxCents`); larger jobs wait for a licensed escrow partner.
- [ ] Billing email set for each partner (`PUT /v1/billing/settings`); `AUTO_BILLING=1`.

## Pilot mode (first 2 weeks per partner)
- **Shadow mode on** for the partner's live account: `PUT /v1/ops/accounts/:id/shadow-mode {"enabled": true}`.
  - Every automatic decision then waits in the dashboard review queue ("Shadow review") until a reviewer confirms or overrides it. Nothing settles unreviewed, not even a forced settlement.
  - An override restarts the appeal window, so the party who now lost can still appeal.
  - Review each case before its appeal window closes: `GET /v1/ops/reviews/pending` lists them, earliest deadline first.
  - **On-chain jobs:** an unreviewed decision can't settle, so a job left unreviewed past its on-chain expiry becomes refundable to the buyer. Review those first.
- Weekly: `GET /v1/ops/reviews/stats` (agreement, false release, false refund per vertical), and export disagreements with `GET /v1/ops/reviews/golden-candidates`. Each line has the spec, inputs, judged delivery and the reviewer's label. Curate them into `evals/<vertical>/` (plan §8, rule 2). They contain customer content, so the pilot agreement must allow this use. Export them before the retention period (default 90 days after the agreement is final) deletes the documents.
- Turn shadow mode off once the partner's shadow agreement rate meets the §6 targets.
- Daily: check `/status` and `GET /v1/ops/metrics` (errors, verification latency and cost), the review queue (escalations and disputes older than 24 h), webhook failures, and the worker log for `errors`.
- Weekly: accuracy (auto decisions vs human review), escalation rate, cost per job, GMV, fees.

## Backups and restore
- **Primary:** Neon point-in-time restore (set retention to at least 7 days). A restore creates a branch: point a staging app at it first, and verify before switching production.
- **Off-site copy, daily** (the destination still needs choosing: encrypted object storage outside Neon):
  - `DATABASE_URL=… npm run db:backup -- <dir>` writes every table in key order plus `manifest.json` (counts, checksums, ledger head, Merkle root).
  - It refuses to back up a broken ledger.
- **Restore a copy:** `RESTORE_DATABASE_URL=<empty database> npm run db:restore -- <dir>`.
  - It migrates, loads, then checks every table byte for byte, the hash chain, the head and Merkle root, and that the ledger is still append-only.
  - It refuses a non-empty target, and exits non-zero on any mismatch.
- **After any restore:** run `GET /v1/ops/ledger/anchors`. An anchor flagged "the ledger is shorter than this anchor" means the restore lost entries that were already published. Recover them from a newer backup or the Neon branch; never re-anchor over the gap.
- **Drill quarterly:** `npm run backup-drill` (last run: docs/ops/backup-drill-2026-10-15.md).

## Incidents
| Symptom | First moves |
|---|---|
| `/status` scheduler down | `fly logs` worker; restart worker machine. Deadlines and settlements catch up on the next tick (all idempotent). |
| `LEDGER CHECK FAILED` | Stop the worker (no settlements). Identify the seq from the log, compare with the last good backup, escalate. Do not "fix" rows: the ledger is append-only by design. |
| Verifier returning 503 | Check Anthropic status and the sandbox host. Jobs wait in `verifying`; re-run `POST /v1/ops/agreements/:id/verify` when it's back. |
| Stripe errors on settlement | Settlements retry each tick with the same idempotency keys. `hold_disputed` needs ops: a chargeback is open. |
| On-chain job near expiry while undecided | `onchain_expiry_near` in tick errors: decide it before expiry or the buyer can reclaim. |
| Suspected attack in a delivery | Leave it escalated; add it to the red-team catalog and golden set. |
