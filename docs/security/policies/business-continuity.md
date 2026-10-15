# Business continuity and backup policy

## Targets
| | Target |
|---|---|
| **RPO (data loss)** | ≤ 5 minutes (Neon point-in-time restore); ≤ 24 hours from the off-site logical backup |
| **RTO (time to restore)** | ≤ 4 hours |
| **Integrity** | After any restore, nothing published may be missing: the anchors check must pass, or the gap is recovered before resuming |

## Backups
- **Primary:** Neon point-in-time restore. Retention ≥ 7 days.
- **Secondary, daily, encrypted, off-site** (provider `[to choose]`): `npm run db:backup`. It writes a verified logical backup, and refuses to back up a broken ledger.
- **Off-chain records are covered by both.** The daily on-chain anchor makes any rollback detectable.

## Restore
Follow docs/launch/runbook.md (Backups and restore):
1. Restore into an empty database.
2. Run `npm run db:restore`, which verifies data, the hash chain, the Merkle root and the triggers.
3. Run `GET /v1/ops/ledger/anchors`.
4. Switch over.

## Drills
`npm run backup-drill` runs every quarter and after major schema changes. Results go in `docs/ops/`. Last run: [2026-10-15](../../ops/backup-drill-2026-10-15.md), passed.

## Degraded modes
These are designed to fail safe:
- **AI provider or code sandbox down:** checks wait (503) and are retried. Nothing is decided against either party.
- **Payment processor down:** settlements retry with the same idempotency keys.
- **Chain RPC down:** settlements retry. Stablecoin buyers can always reclaim after expiry.
