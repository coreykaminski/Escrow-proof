/**
 * Load test: how much the API handles before latency or errors climb, per kind of work.
 *
 * By default it starts the real server on a real (embedded) Postgres and drives it over HTTP.
 * Point it at a deployment instead with LOAD_TARGET_URL + LOAD_API_KEY (a sandbox platform key;
 * that deployment's rate limits apply).
 *
 *   npx tsx scripts/load-test.ts [--seconds 10] [--concurrency 1,8,32] [--out docs/perf/x.md]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createDb } from "@proofdesk/db";
import { verifyData } from "@proofdesk/verifier";
import { createAccountWithKey } from "../apps/api/src/accounts.ts";
import { createApp } from "../apps/api/src/app.ts";
import { PostgresRateLimitStore } from "../apps/api/src/security.ts";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "10" },
    concurrency: { type: "string", default: "1,8,32" },
    out: { type: "string" },
  },
});
const SECONDS = Number(values.seconds);
const LEVELS = String(values.concurrency).split(",").map(Number);

// ---------------------------------------------------------------------------------------------
// Target: a deployment, or a local server on embedded Postgres
// ---------------------------------------------------------------------------------------------

let base = process.env.LOAD_TARGET_URL ?? "";
let key = process.env.LOAD_API_KEY ?? "";
let cleanup = async () => {};
let target = base;

if (!base) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = mkdtempSync(join(tmpdir(), "pd-load-"));
  const port = 56_000 + Math.floor(Math.random() * 4_000);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    postgresFlags: ["-c", "max_connections=200"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  const handle = createDb(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
    maxConnections: 20,
  });
  await handle.migrate();
  key = (await createAccountWithKey(handle.db, { name: "Load test" })).apiKey;
  const app = createApp({
    db: handle.db,
    now: () => new Date(),
    allowPrivateNetwork: true,
    rateLimits: { apiPerMinute: 10_000_000, publicPerMinute: 10_000_000 },
    rateLimitStore: new PostgresRateLimitStore(handle.db),
    dataVerifier: (input) => verifyData(input, {}),
  });
  const appPort = 57_000 + Math.floor(Math.random() * 2_000);
  const server = serve({ fetch: app.fetch, port: appPort });
  base = `http://127.0.0.1:${appPort}`;
  target = `local server on embedded Postgres (pool 20), ${cpus().length} CPUs, ${Math.round(totalmem() / 2 ** 30)} GB`;
  cleanup = async () => {
    server.close();
    await handle.close();
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------------------------
// Scenarios: one "operation" each, timed end to end
// ---------------------------------------------------------------------------------------------

const due = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const SCHEMA = JSON.stringify({
  type: "array",
  "x-unique-keys": ["id"],
  items: {
    type: "object",
    required: ["id", "name"],
    properties: { id: { type: "integer" }, name: { type: "string" } },
  },
});
const CSV = `id,name\n${Array.from({ length: 50 }, (_, i) => `${i},item-${i}`).join("\n")}\n`;

const scenarios: { name: string; describe: string; op: () => Promise<unknown> }[] = [
  {
    name: "read",
    describe: "GET /v1/agreements (authenticated list)",
    op: () => call("GET", "/v1/agreements?limit=20"),
  },
  {
    name: "purchase",
    describe: "create from template → approve → fund → deliver (4 writes, 4 ledger entries)",
    op: async () => {
      const a = await call("POST", "/v1/agreements/from-template", {
        buyer_ref: "b",
        seller_ref: "s",
        template: "data.dataset",
        params: { task: "A dataset.", min_records: 10 },
        amount: { value: 5_000, currency: "usd" },
        delivery_due_at: due(),
      });
      await call("POST", `/v1/agreements/${a.id}/approve-spec`, { spec_hash: a.spec_hash });
      await call("POST", `/v1/agreements/${a.id}/fund`, { rail: "test", hold_ref: "load" });
      await call("POST", `/v1/agreements/${a.id}/deliveries`, {
        artifacts: [{ name: "data.csv", media_type: "text/csv", content: CSV }],
      });
    },
  },
  {
    name: "verify",
    describe: "POST /v1/verifications: a 50-row CSV checked against a JSON Schema (no model)",
    op: () =>
      call("POST", "/v1/verifications", {
        template: {
          id: "data.dataset",
          params: { task: "Items.", min_records: 10, unique_key: "id" },
        },
        inputs: [{ name: "schema.json", media_type: "application/schema+json", content: SCHEMA }],
        deliverable: [{ name: "items.csv", media_type: "text/csv", content: CSV }],
      }),
  },
  {
    name: "public",
    describe: "GET /ledger/checkpoint.json (Merkle tree head from stored subtrees)",
    op: async () => {
      const res = await fetch(`${base}/ledger/checkpoint.json`);
      if (!res.ok) throw new Error(`checkpoint ${res.status}`);
      await res.text();
    },
  },
];

interface Result {
  scenario: string;
  concurrency: number;
  ops: number;
  errors: number;
  firstError?: string;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
}

async function run(s: (typeof scenarios)[number], concurrency: number): Promise<Result> {
  const latencies: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  const until = Date.now() + SECONDS * 1000;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < until) {
        const t = performance.now();
        try {
          await s.op();
          latencies.push(performance.now() - t);
        } catch (err) {
          errors++;
          firstError ??= err instanceof Error ? err.message : String(err);
        }
      }
    }),
  );
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0);
  return {
    scenario: s.name,
    concurrency,
    ops: latencies.length,
    errors,
    ...(firstError ? { firstError } : {}),
    perSecond: Math.round((latencies.length / elapsed) * 10) / 10,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

const results: Result[] = [];
try {
  await call("GET", "/v1/agreements?limit=1"); // warm up
  for (const s of scenarios) {
    for (const c of LEVELS) {
      const r = await run(s, c);
      results.push(r);
      console.log(
        `${s.name.padEnd(9)} c=${String(c).padStart(3)}  ${String(r.perSecond).padStart(7)} ops/s  p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  errors ${r.errors}${r.firstError ? ` (${r.firstError})` : ""}`,
      );
    }
  }
} finally {
  await cleanup();
}

const report = [
  `# Load test, ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Target: ${target}. Each scenario ran ${SECONDS}s per concurrency level; latency is per operation, end to end over HTTP.`,
  "",
  ...scenarios.map((s) => `- **${s.name}**: ${s.describe}`),
  "",
  "| Scenario | Concurrency | Ops/s | p50 ms | p95 ms | p99 ms | Errors |",
  "|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.scenario} | ${r.concurrency} | ${r.perSecond} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.errors} |`,
  ),
  "",
].join("\n");
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, report);
  console.log(`wrote ${values.out}`);
}
