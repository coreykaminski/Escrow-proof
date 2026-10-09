import { createHash } from "node:crypto";

/**
 * Merkle tree over the ledger, as in Certificate Transparency (RFC 6962; verification
 * algorithms from RFC 9162 §2.1). Leaf i is ledger entry seq i+1, and its leaf data is that
 * entry's 32-byte hash. A tree head (size, root) commits to the first `size` entries; it is
 * what gets anchored on-chain. An inclusion proof shows one entry is in a tree head without
 * revealing any other entry; a consistency proof shows a later head extends an earlier one.
 *
 * Hex strings at the edges, bytes inside.
 */

export const MERKLE_SCHEME = "rfc6962-sha256";

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const fromHex = (h: string) => {
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error("not lowercase hex");
  return new Uint8Array(Buffer.from(h, "hex"));
};

/** RFC 6962 leaf hash: SHA-256(0x00 || data). */
export function leafHash(data: Uint8Array): Uint8Array {
  return sha256(LEAF, data);
}

/** RFC 6962 interior node: SHA-256(0x01 || left || right). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(NODE, left, right);
}

/** Largest power of two strictly less than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over already-hashed leaves. The empty tree's root is SHA-256 of the empty string. */
export function rootOf(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256();
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = split(leaves.length);
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

/** PATH(m, D[n]): the audit path for leaf `index`. */
export function inclusionPath(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...inclusionPath(leaves.slice(0, k), index), rootOf(leaves.slice(k))]
    : [...inclusionPath(leaves.slice(k), index - k), rootOf(leaves.slice(0, k))];
}

/** PROOF(m, D[n]): proves the first `m` leaves' tree is a prefix of the whole tree. */
export function consistencyPath(leaves: readonly Uint8Array[], m: number): Uint8Array[] {
  if (m < 1 || m > leaves.length) throw new RangeError("old tree size out of range");
  const sub = (m: number, d: readonly Uint8Array[], whole: boolean): Uint8Array[] => {
    if (m === d.length) return whole ? [] : [rootOf(d)];
    const k = split(d.length);
    return m <= k
      ? [...sub(m, d.slice(0, k), whole), rootOf(d.slice(k))]
      : [...sub(m - k, d.slice(k), false), rootOf(d.slice(0, k))];
  };
  return sub(m, leaves, true);
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** RFC 9162 §2.1.3.2: is `leaf` (a leaf hash) at `index` in the tree (size, root)? */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  size: number,
  path: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) {
    return false;
  }
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && same(r, root);
}

/** RFC 9162 §2.1.4.2: does the tree (second, secondRoot) extend (first, firstRoot)? */
export function verifyConsistency(
  first: number,
  second: number,
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
  path: readonly Uint8Array[],
): boolean {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return false;
  if (first < 1 || first > second) return false;
  if (first === second) return path.length === 0 && same(firstRoot, secondRoot);
  const c = [...path];
  // A power-of-two old tree is a complete subtree: its root starts the path.
  if ((first & (first - 1)) === 0) c.unshift(firstRoot);
  if (c.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = c[0] as Uint8Array;
  let sr = c[0] as Uint8Array;
  for (const p of c.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(p, fr);
      sr = nodeHash(p, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = nodeHash(sr, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && same(fr, firstRoot) && same(sr, secondRoot);
}

/** The ledger's leaf for an entry: the leaf hash of its 32-byte entry hash. */
export const ledgerLeaf = (entryHashHex: string) => leafHash(fromHex(entryHashHex));
