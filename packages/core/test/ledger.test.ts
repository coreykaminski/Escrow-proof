import { describe, expect, it } from "vitest";
import {
  buildEntry,
  computeEntryHash,
  GENESIS_HASH,
  type LedgerEntry,
  verifyChain,
} from "../src/ledger.ts";

function chain(n: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(
      buildEntry(entries.at(-1) ?? null, {
        agreementId: `agr_${i % 3}`,
        type: "agreement.test",
        payload: { i, note: `entry ${i}` },
        createdAt: new Date(Date.UTC(2026, 9, 6, 12, 0, i)),
      }),
    );
  }
  return entries;
}

describe("ledger hash chain", () => {
  it("starts from the genesis hash and links each entry to the previous one", () => {
    const entries = chain(3);
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]?.prevHash).toBe(entries[0]?.entryHash);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("verifies an intact chain and reports the head", () => {
    const entries = chain(25);
    expect(verifyChain(entries)).toEqual({
      ok: true,
      count: 25,
      headSeq: 25,
      headHash: entries[24]?.entryHash,
    });
  });

  it("verifies an empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, headSeq: 0, headHash: GENESIS_HASH });
  });

  it("detects an edited payload", () => {
    const entries = chain(5);
    entries[2] = { ...(entries[2] as LedgerEntry), payload: '{"i":999}' };
    expect(verifyChain(entries)).toMatchObject({ ok: false, seq: 3 });
  });

  it("detects an edit even when the attacker recomputes that entry's hash", () => {
    const entries = chain(5);
    const tampered = { ...(entries[1] as LedgerEntry), type: "agreement.forged" };
    tampered.entryHash = computeEntryHash(tampered);
    entries[1] = tampered;
    // Entry 2 now looks self-consistent, but entry 3 no longer links to it.
    expect(verifyChain(entries)).toMatchObject({
      ok: false,
      seq: 3,
      reason: expect.stringMatching(/prev_hash/),
    });
  });

  it("detects a deleted entry", () => {
    const entries = chain(5);
    entries.splice(2, 1);
    expect(verifyChain(entries)).toMatchObject({ ok: false, seq: 4 });
  });

  it("detects reordering", () => {
    const entries = chain(4);
    const [a, b] = [entries[1] as LedgerEntry, entries[2] as LedgerEntry];
    entries[1] = b;
    entries[2] = a;
    expect(verifyChain(entries)).toMatchObject({ ok: false, seq: 3 });
  });

  it("detects a changed timestamp", () => {
    const entries = chain(3);
    entries[0] = { ...(entries[0] as LedgerEntry), createdAt: "2020-01-01T00:00:00.000Z" };
    expect(verifyChain(entries)).toMatchObject({ ok: false, seq: 1 });
  });
});
