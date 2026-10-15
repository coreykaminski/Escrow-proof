/**
 * Back up the database (DATABASE_URL, Postgres) into a directory: one file per table in
 * primary-key order plus manifest.json (row counts, checksums, ledger head and Merkle root).
 *
 *   DATABASE_URL=postgres://… npm run db:backup -- ./backups/2026-10-15
 */
import { backupDatabase } from "@proofdesk/db";
import { loadEnv } from "../apps/api/src/load-env.ts";

loadEnv();
const dir = process.argv[2];
const url = process.env.DATABASE_URL ?? "";
if (!dir || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("usage: DATABASE_URL=postgres://… npm run db:backup -- <dir>");
  process.exit(2);
}
const m = await backupDatabase(url, dir);
const rows = m.tables.reduce((n, t) => n + t.rows, 0);
console.log(
  `backed up ${m.tables.length} tables, ${rows} rows; ledger ${m.ledger ? `seq ${m.ledger.head_seq}, root ${m.ledger.merkle_root}` : "empty"} → ${dir}`,
);
