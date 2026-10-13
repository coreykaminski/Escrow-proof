/**
 * Self-serve sandbox sign-up: a developer gets a test-mode API key in a minute, without us.
 * Self-serve accounts only ever hold test keys (live access is set up by Proof Desk), and they
 * have daily quotas on what costs us money: verifier runs (sandboxes, model calls) and AI
 * spec drafting.
 */
import { type Db, schema } from "@proofdesk/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { createAccountWithKey } from "../accounts.ts";
import { ApiError } from "../errors.ts";

export async function signUp(db: Db, p: { name: string; email: string }) {
  const { accountId, apiKey } = await createAccountWithKey(db, { name: p.name, mode: "test" });
  await db
    .update(schema.accounts)
    .set({ selfServe: true, contactEmail: p.email })
    .where(eq(schema.accounts.id, accountId));
  return { accountId, apiKey };
}

export function sandboxLimitsFromEnv(env = process.env) {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isInteger(x) && x >= 0 ? x : d;
  };
  return {
    checksPerDay: n(env.SANDBOX_DAILY_CHECKS, 100),
    draftsPerDay: n(env.SANDBOX_DAILY_DRAFTS, 20),
  };
}

/** Refuses with 429 once a self-serve account has used its daily allowance. Others pass. */
export async function assertSandboxQuota(
  db: Db,
  accountId: string,
  kind: "checks" | "drafts",
  now: Date,
): Promise<void> {
  const [account] = await db
    .select({ selfServe: schema.accounts.selfServe })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!account?.selfServe) return;
  const limits = sandboxLimitsFromEnv();
  const since = new Date(now.getTime() - 86_400_000);
  const limit = kind === "checks" ? limits.checksPerDay : limits.draftsPerDay;
  const [used] =
    kind === "checks"
      ? await db
          .select({ n: count() })
          .from(schema.verifications)
          .innerJoin(schema.agreements, eq(schema.agreements.id, schema.verifications.agreementId))
          .where(
            and(
              eq(schema.agreements.accountId, accountId),
              gte(schema.verifications.createdAt, since),
            ),
          )
      : await db
          .select({ n: count() })
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.accountId, accountId),
              gte(schema.agreements.createdAt, since),
              sql`${schema.agreements.specSource}->>'kind' = 'drafted'`,
            ),
          );
  if ((used?.n ?? 0) >= limit) {
    throw new ApiError(
      429,
      "sandbox_quota_exceeded",
      `this sandbox account has used its ${limit} ${kind === "checks" ? "verifications" : "AI spec drafts"} for the last 24 hours; contact Proof Desk for more`,
    );
  }
}
