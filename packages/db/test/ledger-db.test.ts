import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/client.ts";
import { appendLedgerEntry, listLedgerForAgreement, verifyLedger } from "../src/ledger.ts";

let handle: DbHandle;

beforeEach(async () => {
  handle = createDb("memory://");
  await handle.migrate();
});

afterEach(async () => {
  await handle.close();
});

async function append(n: number, agreementId = "agr_1") {
  for (let i = 0; i < n; i++) {
    await handle.db.transaction((tx) =>
      appendLedgerEntry(tx, {
        agreementId,
        type: "agreement.test",
        payload: { i },
        createdAt: new Date(Date.UTC(2026, 9, 6, 12, 0, 0, i)),
      }),
    );
  }
}

describe("ledger in Postgres", () => {
  it("appends a verifiable chain across agreements", async () => {
    await append(3, "agr_a");
    await append(2, "agr_b");
    const result = await verifyLedger(handle.db);
    expect(result).toMatchObject({ ok: true, count: 5, headSeq: 5 });
    expect((await listLedgerForAgreement(handle.db, "agr_b")).map((e) => e.seq)).toEqual([4, 5]);
  });

  it("verifies across page boundaries", async () => {
    await append(7);
    expect(await verifyLedger(handle.db, 3)).toMatchObject({ ok: true, count: 7 });
  });

  it("serializes concurrent appends into one unbroken chain", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        handle.db.transaction((tx) =>
          appendLedgerEntry(tx, {
            agreementId: `agr_${i}`,
            type: "agreement.test",
            payload: { i },
            createdAt: new Date(),
          }),
        ),
      ),
    );
    expect(await verifyLedger(handle.db)).toMatchObject({ ok: true, count: 20 });
  });

  it("rolls back the ledger entry when its transaction fails", async () => {
    await append(1);
    await expect(
      handle.db.transaction(async (tx) => {
        await appendLedgerEntry(tx, {
          agreementId: "agr_1",
          type: "agreement.test",
          payload: {},
          createdAt: new Date(),
        });
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    expect(await verifyLedger(handle.db)).toMatchObject({ ok: true, count: 1 });
  });

  it.each([
    ["UPDATE", sql`update ledger_entries set type = 'forged' where seq = 1`],
    ["DELETE", sql`delete from ledger_entries where seq = 1`],
    ["TRUNCATE", sql`truncate ledger_entries`],
  ])("blocks %s at the database level", async (_op, statement) => {
    await append(2);
    // Drizzle wraps driver errors; the trigger's message is on the cause.
    const err = await handle.db.execute(statement).then(
      () => null,
      (e: Error) => e,
    );
    expect((err?.cause as Error | undefined)?.message).toMatch(/append-only/);
    expect(await verifyLedger(handle.db)).toMatchObject({ ok: true, count: 2 });
  });

  it("detects tampering by someone who bypasses the triggers", async () => {
    await append(4);
    // A superuser can disable triggers; the hash chain is the second line of defense.
    await handle.db.execute(sql`alter table ledger_entries disable trigger user`);
    await handle.db.execute(sql`update ledger_entries set payload = '{"i":42}' where seq = 2`);
    expect(await verifyLedger(handle.db)).toMatchObject({ ok: false, seq: 2 });
  });
});
