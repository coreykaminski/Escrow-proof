/**
 * Restore a backup into an EMPTY database (RESTORE_DATABASE_URL, never DATABASE_URL, so a slip
 * can't touch production) and verify it: every table byte-identical to the backup, hash chain
 * intact, ledger head and Merkle root unchanged, ledger still append-only. Exit 1 on any failure.
 *
 *   RESTORE_DATABASE_URL=postgres://…/restored npm run db:restore -- ./backups/2026-10-15
 * Then point the app at it and run: GET /v1/ops/ledger/anchors (checks every on-chain anchor).
 */
import { restoreDatabase } from "@proofdesk/db";
import { loadEnv } from "../apps/api/src/load-env.ts";

loadEnv();
const dir = process.argv[2];
const url = process.env.RESTORE_DATABASE_URL ?? "";
if (!dir || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("usage: RESTORE_DATABASE_URL=postgres://… npm run db:restore -- <dir>");
  process.exit(2);
}
const result = await restoreDatabase(url, dir);
for (const c of result.checks)
  console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
console.log(result.ok ? "restore verified" : "RESTORE FAILED VERIFICATION");
process.exit(result.ok ? 0 : 1);
