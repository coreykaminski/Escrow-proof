import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type DbHandle } from "./client.ts";

/** The database tests clone from (migrated once per run by vitest.postgres.ts). */
export const TEST_TEMPLATE_DB = "pd_test_template";

/**
 * A fresh, migrated database for one test. In-memory PGlite by default; with
 * TEST_DATABASE_URL set (`npm run test:postgres`, and CI), a real Postgres database cloned
 * from the migrated template and dropped on close, so tests also prove the SQL works on the
 * database production runs.
 */
export async function createTestDb(): Promise<DbHandle> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) {
    const handle = createDb("memory://");
    await handle.migrate();
    return handle;
  }
  const name = `pd_t_${randomBytes(6).toString("hex")}`;
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`create database ${name} template ${TEST_TEMPLATE_DB}`);
  } finally {
    await sql.end();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), { maxConnections: 3 });
  return {
    ...handle,
    migrate: async () => {},
    close: async () => {
      await handle.close();
      const drop = postgres(admin, { max: 1, onnotice: () => {} });
      try {
        await drop.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await drop.end();
      }
    },
  };
}
