import { createDb, type DbHandle } from "@proofdesk/db";
import { FakeSpecDrafter, type SpecDrafter } from "@proofdesk/spec-engine";
import { createAccountWithKey } from "../src/accounts.ts";
import { createApp } from "../src/app.ts";

export const T0 = new Date("2026-10-06T12:00:00.000Z");
export const HOUR = 3_600_000;

export interface Harness {
  handle: DbHandle;
  clock: { now: Date; advance(ms: number): void };
  keys: { platformA: string; platformB: string; ops: string; live: string };
  drafter: SpecDrafter | undefined;
  call(
    key: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field
  ): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

/** `drafter: undefined` simulates a server without an Anthropic key. */
export async function createHarness(
  opts: { drafter?: SpecDrafter | undefined } = {},
): Promise<Harness> {
  const handle = createDb("memory://");
  await handle.migrate();

  const clock = {
    now: T0,
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };

  const [platformA, platformB, ops, live] = await Promise.all([
    createAccountWithKey(handle.db, { name: "Platform A" }),
    createAccountWithKey(handle.db, { name: "Platform B" }),
    createAccountWithKey(handle.db, { name: "Proof Desk Ops", scopes: ["ops"] }),
    createAccountWithKey(handle.db, { name: "Live Platform", mode: "live" }),
  ]);

  const drafter = "drafter" in opts ? opts.drafter : new FakeSpecDrafter();
  const app = createApp({ db: handle.db, now: () => clock.now, drafter });

  return {
    handle,
    clock,
    keys: {
      platformA: platformA.apiKey,
      platformB: platformB.apiKey,
      ops: ops.apiKey,
      live: live.apiKey,
    },
    drafter,
    async call(key, method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body:
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
    close: () => handle.close(),
  };
}

export function specFixture(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    title: "Translate NDA EN→ES",
    request: "Translate the attached NDA into Spanish (legal register). Pay only if accurate.",
    vertical: "translation",
    criteria: [
      {
        id: "numbers-preserved",
        description: "Every number, date, amount and party name matches the source",
        check: "deterministic",
        critical: true,
      },
      {
        id: "no-omissions",
        description: "Every clause of the source is translated; nothing omitted or added",
        check: "domain",
        critical: true,
      },
      { id: "register", description: "Formal legal register throughout", check: "judge" },
    ],
    amount: { value: 18_000, currency: "usd" },
    delivery_due_at: "2026-10-10T12:00:00Z",
    appeal_window_hours: 72,
    ...over,
  };
}
