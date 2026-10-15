/**
 * Backups restore exactly, and a tampered backup fails verification. Needs real Postgres
 * (COPY streams): runs under `npm run test:postgres` and in CI's postgres job.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { backupDatabase, restoreDatabase } from "../src/backup.ts";
import { createDb } from "../src/client.ts";
import { appendLedgerEntry } from "../src/ledger.ts";

const admin = process.env.TEST_DATABASE_URL;

async function freshDb() {
  const name = `pd_b_${randomBytes(5).toString("hex")}`;
  const sql = postgres(admin as string, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create database ${name}`);
  await sql.end();
  const url = new URL(admin as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function seeded() {
  const url = await freshDb();
  const h = createDb(url, { maxConnections: 2 });
  await h.migrate();
  for (let i = 0; i < 12; i++) {
    await h.db.transaction((tx) =>
      appendLedgerEntry(tx, {
        agreementId: null,
        type: "drill.test",
        payload: { i, note: "tab\there, newline\nhere, backslash \\ here" },
        createdAt: new Date(Date.UTC(2026, 9, 15, 10, 0, i)),
      }),
    );
  }
  await h.close();
  return url;
}

describe.skipIf(!admin)("backup and restore (Postgres)", () => {
  it("round-trips exactly, including awkward characters, and verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-bk-"));
    const manifest = await backupDatabase(await seeded(), dir);
    expect(manifest.ledger?.head_seq).toBe(12);
    const result = await restoreDatabase(await freshDb(), dir);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails verification when the backup was tampered with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-bk-"));
    await backupDatabase(await seeded(), dir);
    const file = join(dir, "ledger_entries.copy");
    writeFileSync(file, readFileSync(file, "utf8").replace('"i":3', '"i":4'));
    const result = await restoreDatabase(await freshDb(), dir);
    expect(result.ok).toBe(false);
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(
      expect.arrayContaining(["table ledger_entries", "hash chain verifies from genesis"]),
    );
  });

  it("refuses to restore over a database that has data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-bk-"));
    await backupDatabase(await seeded(), dir);
    await expect(restoreDatabase(await seeded(), dir)).rejects.toThrow("non-empty database");
  });
});
