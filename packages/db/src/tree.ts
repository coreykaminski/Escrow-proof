import {
  fromHex,
  ledgerLeaf,
  type NodeGetter,
  nodeHash,
  nodesNeeded,
  toHex,
} from "@proofdesk/core";
import { and, asc, eq, gt, max, or } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { ledgerEntries, ledgerTreeNodes } from "./schema.ts";

/**
 * Brings the stored complete subtrees up to the ledger head: for each new entry, its leaf and
 * every node it completes. Idempotent (nodes are deterministic; conflicts are ignored), so it is
 * safe from the append path and from readers. Normally there's one new entry; the first run on
 * an existing ledger backfills everything.
 */
export async function syncTreeNodes(db: DbOrTx, pageSize = 5000): Promise<number> {
  const [done] = await db
    .select({ n: max(ledgerTreeNodes.idx) })
    .from(ledgerTreeNodes)
    .where(eq(ledgerTreeNodes.level, 0));
  let leaves = done?.n === null || done?.n === undefined ? 0 : Number(done.n) + 1;
  const cache = new Map<string, Uint8Array>();
  const stored = async (level: number, idx: number) => {
    const hit = cache.get(`${level}:${idx}`);
    if (hit) return hit;
    const [row] = await db
      .select({ hash: ledgerTreeNodes.hash })
      .from(ledgerTreeNodes)
      .where(and(eq(ledgerTreeNodes.level, level), eq(ledgerTreeNodes.idx, idx)));
    if (!row) throw new Error(`ledger tree node ${level}:${idx} is missing`);
    return fromHex(row.hash);
  };
  while (true) {
    const rows = await db
      .select({ seq: ledgerEntries.seq, entryHash: ledgerEntries.entryHash })
      .from(ledgerEntries)
      .where(gt(ledgerEntries.seq, leaves))
      .orderBy(asc(ledgerEntries.seq))
      .limit(pageSize);
    if (rows.length === 0) return leaves;
    const out: { level: number; idx: number; hash: string }[] = [];
    for (const r of rows) {
      const index = r.seq - 1;
      if (index !== leaves) throw new Error(`ledger gap before seq ${r.seq}`);
      let cur = ledgerLeaf(r.entryHash);
      let level = 0;
      let i = index;
      const put = () => {
        cache.set(`${level}:${i}`, cur);
        out.push({ level, idx: i, hash: toHex(cur) });
      };
      put();
      while (i % 2 === 1) {
        cur = nodeHash(await stored(level, i - 1), cur);
        level++;
        i = (i - 1) / 2;
        put();
      }
      leaves++;
    }
    for (let k = 0; k < out.length; k += 1000) {
      await db
        .insert(ledgerTreeNodes)
        .values(out.slice(k, k + 1000))
        .onConflictDoNothing();
    }
    if (rows.length < pageSize) return leaves;
  }
}

/**
 * The append path: stores leaf `index` and the nodes it completes with one lookup (its
 * predecessor leaf and the left siblings it pairs with) and one insert. If the stored tree is
 * behind (e.g. a ledger from before the cache), it falls back to a full in-order sync, so the
 * stored leaves always form a gap-free prefix.
 */
export async function appendTreeLeaf(db: DbOrTx, index: number, entryHash: string) {
  const siblings: [number, number][] = [];
  for (let level = 0, i = index; i % 2 === 1; level++, i = (i - 1) / 2) {
    siblings.push([level, i - 1]);
  }
  const keys: [number, number][] = [...siblings];
  if (index > 0 && index % 2 === 0) keys.push([0, index - 1]);
  const found = new Map<string, Uint8Array>();
  if (keys.length) {
    const rows = await db
      .select()
      .from(ledgerTreeNodes)
      .where(
        or(
          ...keys.map(([level, idx]) =>
            and(eq(ledgerTreeNodes.level, level), eq(ledgerTreeNodes.idx, idx)),
          ),
        ),
      );
    for (const r of rows) found.set(`${r.level}:${r.idx}`, fromHex(r.hash));
  }
  if (keys.some(([l, i]) => !found.has(`${l}:${i}`))) {
    await syncTreeNodes(db);
    return;
  }
  let cur = ledgerLeaf(entryHash);
  const out = [{ level: 0, idx: index, hash: toHex(cur) }];
  for (const [level, left] of siblings) {
    cur = nodeHash(found.get(`${level}:${left}`) as Uint8Array, cur);
    out.push({ level: level + 1, idx: left / 2, hash: toHex(cur) });
  }
  await db.insert(ledgerTreeNodes).values(out).onConflictDoNothing();
}

/**
 * Runs a tree computation (root, inclusion or consistency proof from core/merkle.ts) against
 * the stored subtrees: it learns which nodes it needs, fetches them in one query, then runs.
 */
export async function withLedgerTree<T>(db: DbOrTx, compute: (get: NodeGetter) => T): Promise<T> {
  await syncTreeNodes(db);
  const keys = nodesNeeded(compute);
  const nodes = new Map<string, Uint8Array>();
  if (keys.length) {
    const rows = await db
      .select()
      .from(ledgerTreeNodes)
      .where(
        or(
          ...keys.map(([level, idx]) =>
            and(eq(ledgerTreeNodes.level, level), eq(ledgerTreeNodes.idx, idx)),
          ),
        ),
      );
    for (const r of rows) nodes.set(`${r.level}:${r.idx}`, fromHex(r.hash));
  }
  return compute((level, idx) => {
    const n = nodes.get(`${level}:${idx}`);
    if (!n) throw new Error(`ledger tree node ${level}:${idx} is missing`);
    return n;
  });
}
