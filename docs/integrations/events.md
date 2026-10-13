# Events

Everything that happens to an agreement is a ledger entry, and each one is delivered as an event.
- **Webhooks:** in ledger order, at least once, signed (`Proofdesk-Signature`, verify with `verifyWebhook`).
- **`GET /v1/events`:** for backfilling or polling.

Every event looks like this:
```json
{ "id": "evt_1042", "object": "event", "type": "agreement.decide", "created_at": "…",
  "agreement_id": "agr_…", "data": { … }, "ledger": { "seq": 1042, "entry_hash": "…" } }
```
- `id` is stable, so de-duplicate on it.
- `data` is the ledger payload.
- `ledger` lets you match the event to the verifiable ledger: `GET /v1/agreements/:id/proof`.

## Agreement lifecycle
| Type | When | Notable `data` |
|---|---|---|
| `agreement.created` | Agreement created | `spec_hash`, `spec_source`, `buyer_ref`, `seller_ref`, `livemode` |
| `agreement.spec_replaced` | Spec edited while in draft | `previous_spec_hash`, `spec_hash` |
| `agreement.inputs_replaced` | Inputs (tests, schema, source) replaced while in draft | input hashes |
| `agreement.approve_spec` | Buyer approved the exact spec | `spec_hash` |
| `agreement.cancel` | Cancelled before funding | `reason` |
| `agreement.fund` | Payment held | `rail` (`card`, `onchain`, `test`, `none` for Verify API jobs), `hold_ref` |
| `agreement.deliver` | Seller delivered | `delivery_id`, `manifest_hash` |
| `agreement.start_verification` | Verifier started | |
| `agreement.verification_recorded` | Verifier finished | `verification_id`, `engine_version`, `report_hash`, `action` |
| `agreement.escalate` | A human will decide | `reason` |
| `agreement.decide` | Decision made | `outcome` (`release` / `refund` / `partial` + `release_percent`), `decided_by` (`auto` / `human`), `reason`, `review_pending` |
| `agreement.review` | Pilot shadow review confirmed or overrode an automatic decision | `outcome` (null = confirmed), `agreed` |
| `agreement.miss_deadline` | Nothing delivered by the deadline: refund | |
| `agreement.open_dispute` | Buyer or seller appealed | `reason`, `dispute_id` |
| `agreement.resolve_dispute` | A reviewer resolved the appeal (final) | `outcome`, `reason` |
| `agreement.settle` | **Money moved** as decided | `settlement_ref` |
| `agreement.content_deleted` | Documents deleted (retention or on request); hashes remain | `reason`, counts |

## Card holds
| Type | When |
|---|---|
| `hold.created` | Card hold requested |
| `hold.captured` | Captured early, before the authorization lapsed (long jobs) |
| `hold.canceled` | Authorization released (refund before capture: no fee) |
| `hold.expired` | The authorization lapsed |
| `hold.settled` | Payout and refund done for the decision |
| `hold.chargeback_opened` | The buyer's bank opened a chargeback; payout is paused for Proof Desk ops |

## Stablecoin jobs
| Type | When |
|---|---|
| `onchain_job.terms_issued` | Job terms issued for funding |
| `onchain_job.funded` | Buyer funded the job contract |
| `onchain_job.attached` | A job on another ERC-8183 contract was attached |
| `onchain_job.settled` | Settled on-chain (`settle_tx`, amounts) |
| `onchain_job.expired` | The buyer reclaimed an expired job |
| `onchain_job.refunded_late_funding` | Funded after the deadline; returned to the buyer |

## Tools
- **Test:** `POST /v1/webhook-endpoints/:id/test` sends a signed `webhook.test` event (no `agreement_id`, no `ledger`) and reports what your endpoint answered.
- **Replay:** `POST /v1/webhook-endpoints/:id/replay` with `{ "from_event": "evt_1000" }` re-sends everything from that event onward. It also re-enables an endpoint that was disabled after 20 consecutive failures.
- **Backfill or poll:** `GET /v1/events?after=evt_1000&limit=200&type=agreement.decide`. Continue with `next_after`.
- **Filter at the endpoint:** set `event_types` prefixes when you create it, e.g. `["agreement.decide", "agreement.settle", "hold."]`.
- **Retries:** a failing endpoint is retried with exponential backoff (1 minute up to 6 hours). Its cursor advances only past events it answered 2xx to, so nothing is skipped.
