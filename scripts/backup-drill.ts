/**
 * Backup and restore drill, end to end, on real (embedded) Postgres:
 *   1. a "production" database with real activity (verified jobs, settlements, sealed verdicts,
 *      an on-chain anchor);
 *   2. a backup; then more activity and a second anchor (the backup is now behind);
 *   3. restore into a fresh database and verify it (data, hash chain, Merkle root, triggers);
 *   4. run the app on the restored database: anchors check, and an offline proof;
 *   5. show that the on-chain anchors expose the rollback to the older backup.
 *
 *   npx tsx scripts/backup-drill.ts [--out docs/ops/backup-drill-<date>.md]
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { FakeAnchorGateway } from "@proofdesk/chain";
import { type LedgerProof, verifyLedgerProof } from "@proofdesk/core";
import { backupDatabase, createDb, restoreDatabase } from "@proofdesk/db";
import { verifyData } from "@proofdesk/verifier";
import postgres from "postgres";
import { createAccountWithKey } from "../apps/api/src/accounts.ts";
import { createApp } from "../apps/api/src/app.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const work = mkdtempSync(join(tmpdir(), "pd-drill-"));
const port = 58_000 + Math.floor(Math.random() * 1_000);
const pg = new EmbeddedPostgres({
  databaseDir: join(work, "pg"),
  port,
  user: "postgres",
  password: "postgres",
  persistent: false,
  onLog: () => {},
});
await pg.initialise();
await pg.start();
const admin = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
  max: 1,
  onnotice: () => {},
});
await admin`create database prod`;
await admin`create database restored`;
await admin.end();
const PROD = `postgres://postgres:postgres@127.0.0.1:${port}/prod`;
const RESTORED = `postgres://postgres:postgres@127.0.0.1:${port}/restored`;
const anchor = new FakeAnchorGateway(); // stands in for the LedgerAnchor contract
let failed = false;

try {
  // 1. Production, with activity.
  const prod = createDb(PROD, { maxConnections: 5 });
  await prod.migrate();
  const live = await createAccountWithKey(prod.db, { name: "Drill Platform", mode: "live" });
  const ops = await createAccountWithKey(prod.db, { name: "Drill Ops", scopes: ["ops"] });
  let clock = new Date();
  const app = (db: typeof prod.db) =>
    createApp({ db, now: () => clock, anchor, dataVerifier: (input) => verifyData(input, {}) });
  const prodApp = app(prod.db);
  const call = async (
    a: ReturnType<typeof createApp>,
    key: string,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const res = await a.request(path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json();
    if (res.status >= 400) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const schema = JSON.stringify({ type: "array", items: { type: "object", required: ["id"] } });
  const jobs = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const ok = i % 4 !== 3;
      const job = await call(prodApp, live.apiKey, "POST", "/v1/verifications", {
        template: { id: "data.dataset", params: { task: "Rows.", min_records: 3 } },
        inputs: [{ name: "schema.json", media_type: "application/schema+json", content: schema }],
        deliverable: [
          { name: "d.csv", media_type: "text/csv", content: ok ? "id\n1\n2\n3\n" : "id\n1\n" },
        ],
      });
      ids.push(job.id);
    }
    clock = new Date(clock.getTime() + 3_600_000);
    await call(prodApp, ops.apiKey, "POST", "/v1/ops/run-due");
    return ids;
  };
  const first = await jobs(40);
  const a1 = await call(prodApp, ops.apiKey, "POST", "/v1/ops/ledger/anchor");
  log(
    `1. production: 40 verified and settled jobs, verdicts sealed, anchored on-chain at ledger #${a1.seq}`,
  );

  // 2. Back up; then life goes on.
  const dir = join(work, "backup");
  let t = Date.now();
  const manifest = await backupDatabase(PROD, dir);
  const backupMs = Date.now() - t;
  const bytes = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const rows = manifest.tables.reduce((n, x) => n + x.rows, 0);
  log(
    `2. backup: ${manifest.tables.length} tables, ${rows} rows, ${(bytes / 1024).toFixed(0)} KB in ${backupMs} ms; ledger head #${manifest.ledger?.head_seq}, Merkle root ${manifest.ledger?.merkle_root.slice(0, 16)}…`,
  );
  await jobs(10);
  const a2 = await call(prodApp, ops.apiKey, "POST", "/v1/ops/ledger/anchor");
  log(`   …10 more jobs after the backup; second anchor at ledger #${a2.seq}`);
  await prod.close();

  // 3. Restore into a fresh database and verify.
  t = Date.now();
  const restored = await restoreDatabase(RESTORED, dir);
  log(`3. restore into an empty database (${Date.now() - t} ms):`);
  for (const c of restored.checks.filter((c) => !c.name.startsWith("table ") || !c.ok)) {
    log(`   ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  const tableChecks = restored.checks.filter((c) => c.name.startsWith("table "));
  log(
    `   ${tableChecks.every((c) => c.ok) ? "✓" : "✗"} ${tableChecks.length} tables byte-identical to the backup`,
  );
  if (!restored.ok) failed = true;

  // 4. The app on the restored database.
  const rdb = createDb(RESTORED, { maxConnections: 5 });
  const rApp = app(rdb.db);
  const anchors = await call(rApp, ops.apiKey, "GET", "/v1/ops/ledger/anchors");
  const proof = (await call(
    rApp,
    live.apiKey,
    "GET",
    `/v1/agreements/${first[0]}/proof`,
  )) as LedgerProof;
  const proofOk = verifyLedgerProof(proof).ok && proof.tree.root === anchor.anchors[0]?.headHash;
  log(
    `4. app on the restored database: offline proof for ${first[0]} ${proofOk ? "✓ verifies against the first on-chain anchor" : "✗ FAILED"}`,
  );
  if (!proofOk) failed = true;

  // 5. The anchors expose that this backup is older than what was published.
  const [ok1, ok2] = anchors.anchors as { seq: number; ok: boolean; problem?: string }[];
  log(
    `5. anchors check on the restored database: #${ok1?.seq} ${ok1?.ok ? "✓ matches" : "✗"}; #${ok2?.seq} ${ok2?.ok ? "✗ unexpectedly matches" : `✓ flagged: "${ok2?.problem}"`}`,
  );
  log(
    "   → a restore can't silently roll history back: the published anchor proves entries are missing, and LedgerAnchor refuses to post a lower tree size.",
  );
  if (!ok1?.ok || ok2?.ok) failed = true;
  await rdb.close();
} finally {
  await pg.stop();
  rmSync(work, { recursive: true, force: true });
}

log(failed ? "\nDRILL FAILED" : "\nDrill passed.");
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(
    values.out,
    `# Backup and restore drill, ${new Date().toISOString().slice(0, 10)}\n\nRun with \`npx tsx scripts/backup-drill.ts\` on embedded Postgres 18.\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
  );
}
process.exit(failed ? 1 : 0);
