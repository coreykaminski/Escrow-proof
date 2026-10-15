/**
 * Logical backups we can verify. `backupDatabase` writes every application table (rows in
 * primary-key order, Postgres COPY text format) plus a manifest: row counts, a sha256 per table,
 * the migration level, the ledger head and its Merkle root. `restoreDatabase` loads it into a
 * freshly migrated, empty database in foreign-key order and then proves the restore is exact
 * (every table's bytes match the manifest) and still trustworthy (hash chain, Merkle root,
 * append-only triggers). Postgres only (it streams COPY); for Neon this complements
 * point-in-time restore as an off-site copy.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rootFrom, toHex } from "@proofdesk/core";
import postgres from "postgres";
import { createDb } from "./client.ts";
import { verifyLedger } from "./ledger.ts";
import { withLedgerTree } from "./tree.ts";

export const BACKUP_FORMAT = "proofdesk-backup/1";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  created_at: string;
  migrations: number;
  tables: { name: string; rows: number; sha256: string; file: string }[];
  ledger: { head_seq: number; head_hash: string; merkle_root: string } | null;
}

type Sql = ReturnType<typeof postgres>;

/** Application tables, each with its primary-key columns (for a deterministic row order). */
async function tablesOf(sql: Sql) {
  const rows = await sql<{ table: string; pk: string[] }[]>`
    select c.relname as table,
           array(select a.attname from pg_index i
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                 where i.indrelid = c.oid and i.indisprimary order by a.attnum) as pk
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`;
  return rows;
}

/** Tables in an order where every foreign key points at an earlier table. */
async function loadOrder(sql: Sql, tables: string[]) {
  const edges = await sql<{ child: string; parent: string }[]>`
    select tc.relname as child, tp.relname as parent
    from pg_constraint k
    join pg_class tc on tc.oid = k.conrelid
    join pg_class tp on tp.oid = k.confrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where k.contype = 'f' and n.nspname = 'public' and tc.relname <> tp.relname`;
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (done.has(t)) return;
    if (path.has(t)) throw new Error(`foreign-key cycle through ${t}`);
    path.add(t);
    for (const e of edges.filter((x) => x.child === t)) visit(e.parent, path);
    path.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return order;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function copyOut(sql: Sql, table: string, pk: string[]): Promise<Buffer> {
  const orderBy = pk.length ? ` order by ${pk.map(ident).join(", ")}` : "";
  const stream = await sql
    .unsafe(`copy (select * from ${ident(table)}${orderBy}) to stdout`)
    .readable();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function ledgerSummary(url: string) {
  const handle = createDb(url, { maxConnections: 2 });
  try {
    const v = await verifyLedger(handle.db);
    if (!v.ok) return { ok: false as const, problem: `ledger broken at seq ${v.seq}: ${v.reason}` };
    if (v.count === 0) return { ok: true as const, ledger: null };
    const root = await withLedgerTree(handle.db, (get) => rootFrom(get, v.headSeq));
    return {
      ok: true as const,
      ledger: { head_seq: v.headSeq, head_hash: v.headHash, merkle_root: toHex(root) },
    };
  } finally {
    await handle.close();
  }
}

/** Writes a backup of the database at `url` into `dir` (created if needed). */
export async function backupDatabase(url: string, dir: string): Promise<BackupManifest> {
  mkdirSync(dir, { recursive: true });
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // One consistent snapshot of every table.
    const tables: BackupManifest["tables"] = [];
    let migrations = 0;
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const [m] = await tx`select count(*)::int as n from drizzle.__drizzle_migrations`;
      migrations = m?.n ?? 0;
      for (const t of await tablesOf(tx as unknown as Sql)) {
        const data = await copyOut(tx as unknown as Sql, t.table, t.pk);
        const file = `${t.table}.copy`;
        writeFileSync(join(dir, file), data);
        tables.push({
          name: t.table,
          rows: data.length === 0 ? 0 : data.toString("utf8").split("\n").length - 1,
          sha256: createHash("sha256").update(data).digest("hex"),
          file,
        });
      }
    });
    const summary = await ledgerSummary(url);
    if (!summary.ok) throw new Error(`refusing to back up a broken ledger: ${summary.problem}`);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      created_at: new Date().toISOString(),
      migrations,
      tables,
      ledger: summary.ledger,
    };
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await sql.end();
  }
}

export interface RestoreCheck {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Restores `dir` into the EMPTY database at `url` (migrated first), then verifies it. Refuses a
 * database that already has data.
 */
export async function restoreDatabase(url: string, dir: string): Promise<RestoreCheck> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT)
    throw new Error(`unknown backup format ${manifest.format}`);
  const handle = createDb(url, { maxConnections: 2 });
  await handle.migrate();
  await handle.close();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const checks: RestoreCheck["checks"] = [];
  try {
    const live = await tablesOf(sql);
    for (const t of live) {
      const [r] = await sql.unsafe(`select exists(select 1 from ${ident(t.table)}) as any`);
      if (r?.any) throw new Error(`refusing to restore into a non-empty database (${t.table})`);
    }
    const [m] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    checks.push({
      name: "schema migrations",
      ok: (m?.n ?? 0) >= manifest.migrations,
      detail: `${m?.n} applied, backup taken at ${manifest.migrations}`,
    });

    const byName = new Map(manifest.tables.map((t) => [t.name, t]));
    const order = await loadOrder(
      sql,
      live.map((t) => t.table),
    );
    await sql.begin(async (tx) => {
      for (const table of order) {
        const entry = byName.get(table);
        if (!entry) continue; // a table added by a newer migration: starts empty
        const data = readFileSync(join(dir, entry.file));
        if (data.length === 0) continue;
        const sink = await (tx as unknown as Sql)
          .unsafe(`copy ${ident(table)} from stdin`)
          .writable();
        await pipeline(Readable.from([data]), sink as Writable);
      }
    });

    for (const t of live) {
      const entry = byName.get(t.table);
      if (!entry) continue;
      const data = await copyOut(sql, t.table, t.pk);
      const sha = createHash("sha256").update(data).digest("hex");
      checks.push({
        name: `table ${t.table}`,
        ok: sha === entry.sha256,
        detail: `${entry.rows} rows`,
      });
    }
    const missing = manifest.tables.filter((t) => !live.some((l) => l.table === t.name));
    checks.push({
      name: "every backed-up table exists",
      ok: missing.length === 0,
      ...(missing.length ? { detail: missing.map((t) => t.name).join(", ") } : {}),
    });

    // The ledger must still be append-only after the restore.
    let blocked = false;
    try {
      await sql.begin(async (tx) => {
        await tx`update ledger_entries set type = type where seq = (select min(seq) from ledger_entries)`;
        await tx`delete from ledger_entries where false`;
        throw new Error("rollback");
      });
    } catch (err) {
      blocked = !(err instanceof Error && err.message === "rollback");
    }
    const hasLedger = (manifest.ledger?.head_seq ?? 0) > 0;
    checks.push({
      name: "ledger is append-only (update refused)",
      ok: !hasLedger || blocked,
    });
  } finally {
    await sql.end();
  }

  const summary = await ledgerSummary(url);
  checks.push({
    name: "hash chain verifies from genesis",
    ok: summary.ok,
    ...(summary.ok ? {} : { detail: summary.problem }),
  });
  if (summary.ok) {
    const same = JSON.stringify(summary.ledger) === JSON.stringify(manifest.ledger);
    checks.push({
      name: "ledger head and Merkle root match the backup",
      ok: same,
      detail: summary.ledger
        ? `seq ${summary.ledger.head_seq}, root ${summary.ledger.merkle_root.slice(0, 16)}…`
        : "empty ledger",
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
