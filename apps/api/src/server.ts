import { serve } from "@hono/node-server";
import { createDb } from "@proofdesk/db";
import { createApp } from "./app.ts";

const databaseUrl = process.env.DATABASE_URL ?? "pglite:./.data/dev";
const port = Number(process.env.PORT ?? 8787);

const handle = createDb(databaseUrl);
await handle.migrate();

const app = createApp({ db: handle.db, now: () => new Date() });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Proof Desk API listening on http://localhost:${info.port} (${handle.driver})`);
});

async function shutdown() {
  server.close();
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
