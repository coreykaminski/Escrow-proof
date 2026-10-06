import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  driver: "pglite" | "postgres";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * `url` forms:
 *   - "memory://"            in-memory embedded Postgres (tests)
 *   - "pglite:./.data/dev"   embedded Postgres persisted to a directory (local dev)
 *   - "postgres://..."       a real Postgres server (staging/production)
 */
export function createDb(url: string): DbHandle {
  if (url === "memory://" || url.startsWith("pglite:")) {
    const client = url === "memory://" ? new PGlite() : new PGlite(url.slice("pglite:".length));
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return {
      db,
      driver: "pglite",
      migrate: () => migratePglite(db as never, { migrationsFolder }),
      close: () => client.close(),
    };
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const client = postgres(url, { max: 10 });
    const db = drizzlePostgres(client, { schema }) as unknown as Db;
    return {
      db,
      driver: "postgres",
      migrate: () => migratePostgres(db as never, { migrationsFolder }),
      close: () => client.end(),
    };
  }

  throw new Error(`Unsupported DATABASE_URL: ${url.split(":")[0]}://…`);
}
