# Backup and restore drill, 2026-10-15

Run with `npx tsx scripts/backup-drill.ts` on embedded Postgres 18.

```
1. production: 40 verified and settled jobs, verdicts sealed, anchored on-chain at ledger #400
2. backup: 27 tables, 1485 rows, 358 KB in 58 ms; ledger head #401, Merkle root 74719cbeb6b62df6…
   …10 more jobs after the backup; second anchor at ledger #501
3. restore into an empty database (133 ms):
   ✓ schema migrations: 17 applied, backup taken at 17
   ✓ every backed-up table exists
   ✓ ledger is append-only (update refused)
   ✓ hash chain verifies from genesis
   ✓ ledger head and Merkle root match the backup: seq 401, root 74719cbeb6b62df6…
   ✓ 27 tables byte-identical to the backup
4. app on the restored database: offline proof for agr_01M4ZXH5QDPRJ0BD338K5PT0X9 ✓ verifies against the first on-chain anchor
5. anchors check on the restored database: #400 ✓ matches; #501 ✓ flagged: "the ledger is shorter than this anchor"
   → a restore can't silently roll history back: the published anchor proves entries are missing, and LedgerAnchor refuses to post a lower tree size.

Drill passed.
```
