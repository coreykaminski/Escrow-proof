import { type Db, schema, verifyLedger } from "@proofdesk/db";
import { count, eq, gt, sql } from "drizzle-orm";
import type { AppDeps } from "../env.ts";

export type Health = "operational" | "degraded" | "down" | "not_configured";

export interface Component {
  name: string;
  status: Health;
  detail: string;
}

const MINUTE = 60_000;

export async function setState(db: Db, key: string, value: Record<string, unknown>, now: Date) {
  await db
    .insert(schema.systemState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.systemState.key, set: { value, updatedAt: now } });
}

export async function getState(db: Db, key: string) {
  const [row] = await db.select().from(schema.systemState).where(eq(schema.systemState.key, key));
  return row;
}

/** Re-verifies the whole ledger hash chain and records the result (run by the worker). */
export async function checkLedger(db: Db, now: Date) {
  const result = await verifyLedger(db);
  await setState(db, "ledger.verify", { ...result }, now);
  return result;
}

/**
 * Public health summary. Says what's configured and working, never anything about customers
 * (no ids, counts per account, or error messages from integrations).
 */
export async function systemStatus(
  deps: AppDeps,
): Promise<{ status: Health; components: Component[] }> {
  const { db } = deps;
  const now = deps.now();
  const components: Component[] = [];

  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    components.push({
      name: "API and database",
      status: "operational",
      detail: `${Date.now() - t0} ms`,
    });
  } catch {
    components.push({ name: "API and database", status: "down", detail: "database unreachable" });
    return { status: "down", components };
  }

  const tick = await getState(db, "scheduler.tick");
  const age = tick ? now.getTime() - tick.updatedAt.getTime() : null;
  components.push({
    name: "Scheduler (settlements, deadlines, webhooks)",
    status:
      age === null
        ? "down"
        : age < 5 * MINUTE
          ? "operational"
          : age < 30 * MINUTE
            ? "degraded"
            : "down",
    detail: age === null ? "no run recorded" : `last run ${Math.round(age / 1000)} s ago`,
  });

  const ledger = await getState(db, "ledger.verify");
  const ledgerOk = ledger?.value.ok === true;
  components.push({
    name: "Ledger integrity",
    status: !ledger ? "degraded" : ledgerOk ? "operational" : "down",
    detail: !ledger
      ? "not verified yet"
      : ledgerOk
        ? `hash chain verified (${String(ledger.value.count ?? "?")} entries) ${Math.round((now.getTime() - ledger.updatedAt.getTime()) / MINUTE)} min ago`
        : "hash chain check failed; investigating",
  });

  if (deps.anchor) {
    const a = await getState(db, "ledger.anchor");
    const ageH = a ? (now.getTime() - a.updatedAt.getTime()) / 3_600_000 : null;
    components.push({
      name: "Ledger anchoring (on-chain)",
      status: ageH === null ? "degraded" : ageH < 48 ? "operational" : "degraded",
      detail:
        ageH === null
          ? "no anchor yet"
          : `head seq ${String(a?.value.seq)} anchored ${Math.round(ageH)} h ago on chain ${String(a?.value.chain_id)}`,
    });
  }
  components.push({
    name: "Card payments (Stripe)",
    status: deps.payments ? "operational" : "not_configured",
    detail: deps.payments ? `${deps.payments.mode} mode` : "—",
  });
  let chainDetail = "—";
  if (deps.chain) {
    try {
      const cfg = await deps.chain.config();
      chainDetail = `chain ${cfg.chainId} (${cfg.mode})`;
    } catch {
      chainDetail = "RPC unreachable";
    }
  }
  components.push({
    name: "Stablecoin payments (USDC)",
    status: !deps.chain
      ? "not_configured"
      : chainDetail === "RPC unreachable"
        ? "degraded"
        : "operational",
    detail: chainDetail,
  });
  const verifiers = [
    ["translation", deps.verifier],
    ["code", deps.codeVerifier],
    ["data", deps.dataVerifier],
  ] as const;
  for (const [name, v] of verifiers) {
    components.push({
      name: `Verifier: ${name}`,
      status: v ? "operational" : "not_configured",
      detail: v ? "available" : "—",
    });
  }

  const [failing] = await db
    .select({ n: count() })
    .from(schema.webhookEndpoints)
    .where(gt(schema.webhookEndpoints.failureCount, 0));
  components.push({
    name: "Outbound webhooks",
    status: "operational",
    detail: (failing?.n ?? 0) > 0 ? "delivering; some endpoints are retrying" : "delivering",
  });

  const rank: Record<Health, number> = { operational: 0, not_configured: 0, degraded: 1, down: 2 };
  const worst = components.reduce(
    (w, c) => (rank[c.status] > rank[w] ? c.status : w),
    "operational" as Health,
  );
  return { status: worst, components };
}
