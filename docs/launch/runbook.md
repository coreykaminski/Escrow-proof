# Design-partner go-live runbook

## Before the first partner touches it
- [ ] Staging deployed per docs/deploy.md; smoke test green.
- [ ] Code sandbox host running with gVisor; one code job verified through it.
- [ ] `/status.json` watched by an uptime monitor that pages Corey.
- [ ] Ops keys: one per human reviewer; each reviewer has finished payout onboarding (`POST /v1/ops/reviewers/me/onboarding`).
- [ ] Model evals run (needs Anthropic credits): `npm run eval:translation`, `eval:code -- --judge`, `eval:data -- --judge`. Every §6 target met, or those decision types set to escalate.

## Before real money (live keys)
- [ ] **Fintech lawyer sign-off** on the card flow, the stablecoin flow, wording ("conditional payment", never "escrow"), CA platform with US buyers (docs/validation/lawyer-brief.md).
- [ ] Stripe live mode activated; live webhook endpoint and secret set; `STRIPE_EXTENDED_AUTH` only if Stripe enabled it.
- [ ] Third-party pen test, findings fixed.
- [ ] Contract audit booked before any mainnet deployment; evaluator key in a KMS; owner is a multisig.
- [ ] Terms of service and privacy policy published; the pricing page matches the contract with each partner.
- [ ] Lawyer confirms the $5,000 direct-hold limit (`PRICING.directHoldMaxCents`); larger jobs wait for a licensed escrow partner.
- [ ] Billing email set for each partner (`PUT /v1/billing/settings`); `AUTO_BILLING=1`.

## Pilot mode (first 2 weeks per partner)
- **Shadow mode on** for the partner's live account: `PUT /v1/ops/accounts/:id/shadow-mode {"enabled": true}`.
  - Every automatic decision then waits in the dashboard review queue ("Shadow review") until a reviewer confirms or overrides it. Nothing settles unreviewed, not even a forced settlement.
  - An override restarts the appeal window, so the party who now lost can still appeal.
  - Review each case before its appeal window closes: `GET /v1/ops/reviews/pending` lists them, earliest deadline first.
  - **On-chain jobs:** an unreviewed decision can't settle, so a job left unreviewed past its on-chain expiry becomes refundable to the buyer. Review those first.
- Weekly: `GET /v1/ops/reviews/stats` (agreement, false release, false refund per vertical), and export disagreements with `GET /v1/ops/reviews/golden-candidates`. Each line has the spec, inputs, judged delivery and the reviewer's label. Curate them into `evals/<vertical>/` (plan §8, rule 2). They contain customer content, so the pilot agreement must allow this use.
- Turn shadow mode off once the partner's shadow agreement rate meets the §6 targets.
- Daily: check `/status`, the review queue (escalations and disputes older than 24 h), webhook failures, and the worker log for `errors`.
- Weekly: accuracy (auto decisions vs human review), escalation rate, cost per job, GMV, fees.

## Incidents
| Symptom | First moves |
|---|---|
| `/status` scheduler down | `fly logs` worker; restart worker machine. Deadlines and settlements catch up on the next tick (all idempotent). |
| `LEDGER CHECK FAILED` | Stop the worker (no settlements). Identify the seq from the log, compare with the last good backup, escalate. Do not "fix" rows: the ledger is append-only by design. |
| Verifier returning 503 | Check Anthropic status and the sandbox host. Jobs wait in `verifying`; re-run `POST /v1/ops/agreements/:id/verify` when it's back. |
| Stripe errors on settlement | Settlements retry each tick with the same idempotency keys. `hold_disputed` needs ops: a chargeback is open. |
| On-chain job near expiry while undecided | `onchain_expiry_near` in tick errors: decide it before expiry or the buyer can reclaim. |
| Suspected attack in a delivery | Leave it escalated; add it to the red-team catalog and golden set. |
