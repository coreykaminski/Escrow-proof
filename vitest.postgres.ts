/**
 * Global setup for `npm run test:postgres` (TEST_DB=postgres): runs the suite against a real
 * Postgres. Uses TEST_DATABASE_URL when given (CI's service container), otherwise starts an
 * embedded Postgres from npm (no system install). Migrates a template database once; each test
 * harness clones it (packages/db/src/testing.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createDb, TEST_TEMPLATE_DB } from "./packages/db/src/index.ts";

export default async function setup() {
  if (process.env.TEST_DB !== "postgres") return;
  let stop = async () => {};
  if (!process.env.TEST_DATABASE_URL) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "pd-pg-"));
    const port = 55_000 + Math.floor(Math.random() * 5_000);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      port,
      user: "postgres",
      password: "postgres",
      persistent: false,
      postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off"],
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }
  const admin = postgres(process.env.TEST_DATABASE_URL as string, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_TEMPLATE_DB} with (force)`);
  await admin.unsafe(`create database ${TEST_TEMPLATE_DB}`);
  await admin.end();
  const url = new URL(process.env.TEST_DATABASE_URL as string);
  url.pathname = `/${TEST_TEMPLATE_DB}`;
  const template = createDb(url.toString(), { maxConnections: 1 });
  await template.migrate();
  await template.close();
  console.log(`tests run on Postgres (${url.host})`);
  return stop;
}
