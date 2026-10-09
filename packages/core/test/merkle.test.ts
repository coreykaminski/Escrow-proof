import { describe, expect, it } from "vitest";
import {
  consistencyPath,
  consistencyPathFrom,
  inclusionPath,
  inclusionPathFrom,
  leafHash,
  type NodeGetter,
  nodesCompletedBy,
  nodesNeeded,
  rootFrom,
  rootOf,
  toHex,
  verifyConsistency,
  verifyInclusion,
} from "../src/merkle.ts";

// The Certificate Transparency reference leaves and tree heads (RFC 6962 test vectors).
const DATA = [
  "",
  "00",
  "10",
  "2021",
  "3031",
  "40414243",
  "5051525354555657",
  "606162636465666768696a6b6c6d6e6f",
].map((h) => new Uint8Array(Buffer.from(h, "hex")));
const ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
const LEAVES = DATA.map(leafHash);

describe("merkle (RFC 6962)", () => {
  it("matches the reference tree heads", () => {
    expect(toHex(rootOf([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    for (let n = 1; n <= 8; n++) expect(toHex(rootOf(LEAVES.slice(0, n)))).toBe(ROOTS[n - 1]);
  });

  // Larger trees too, so every shape of the recursion is covered.
  const many = Array.from({ length: 37 }, (_, i) => leafHash(new Uint8Array([i, i * 7])));

  it("every leaf's inclusion proof verifies, in every tree size, and nothing else does", () => {
    for (let n = 1; n <= many.length; n++) {
      const tree = many.slice(0, n);
      const root = rootOf(tree);
      for (let i = 0; i < n; i++) {
        const path = inclusionPath(tree, i);
        expect(verifyInclusion(tree[i] as Uint8Array, i, n, path, root)).toBe(true);
        // Wrong index, wrong size, wrong leaf, tampered path: all rejected.
        if (n > 1) {
          expect(verifyInclusion(tree[i] as Uint8Array, (i + 1) % n, n, path, root)).toBe(false);
          expect(
            verifyInclusion(many[n] ?? leafHash(new Uint8Array([255])), i, n, path, root),
          ).toBe(false);
        }
        // (A size only means something paired with its own root: the anchored tree head.)
        if (path.length) {
          const bad = path.map((p, j) => (j === 0 ? leafHash(p) : p));
          expect(verifyInclusion(tree[i] as Uint8Array, i, n, bad, root)).toBe(false);
        }
      }
    }
  });

  it("consistency proofs verify between every pair of sizes, and catch a rewritten history", () => {
    for (let n = 1; n <= many.length; n++) {
      const root = rootOf(many.slice(0, n));
      for (let m = 1; m <= n; m++) {
        const oldRoot = rootOf(many.slice(0, m));
        const path = consistencyPath(many.slice(0, n), m);
        expect(verifyConsistency(m, n, oldRoot, root, path)).toBe(true);
        if (m < n) {
          // An old head that the new tree doesn't extend (history rewritten) fails.
          const rewritten = rootOf([leafHash(new Uint8Array([9, 9])), ...many.slice(1, m)]);
          expect(verifyConsistency(m, n, rewritten, root, path)).toBe(false);
          expect(verifyConsistency(m, n, oldRoot, rootOf(many.slice(0, n - 1)), path)).toBe(false);
        }
      }
    }
  });

  it("rejects out-of-range input", () => {
    expect(() => inclusionPath(LEAVES, 8)).toThrow();
    expect(() => consistencyPath(LEAVES, 0)).toThrow();
    expect(verifyInclusion(LEAVES[0] as Uint8Array, 0, 0, [], rootOf([]))).toBe(false);
    expect(verifyConsistency(0, 3, rootOf([]), rootOf(LEAVES.slice(0, 3)), [])).toBe(false);
  });
});

describe("merkle from stored complete subtrees", () => {
  const many = Array.from({ length: 70 }, (_, i) => leafHash(new Uint8Array([i, i * 3])));
  /** A getter over complete subtrees of `many`, as the database would store them. */
  const stored: NodeGetter = (level, index) => {
    const start = index * 2 ** level;
    const end = start + 2 ** level;
    if (end > many.length) throw new Error(`node ${level}:${index} isn't complete`);
    return rootOf(many.slice(start, end));
  };

  it("gives the same roots and proofs as the leaf-by-leaf computation", () => {
    for (let n = 1; n <= many.length; n++) {
      const tree = many.slice(0, n);
      expect(toHex(rootFrom(stored, n))).toBe(toHex(rootOf(tree)));
      for (const i of [0, Math.floor(n / 2), n - 1]) {
        expect(inclusionPathFrom(stored, i, n).map(toHex)).toEqual(
          inclusionPath(tree, i).map(toHex),
        );
      }
      for (const m of [1, Math.ceil(n / 3), n]) {
        expect(consistencyPathFrom(stored, m, n).map(toHex)).toEqual(
          consistencyPath(tree, m).map(toHex),
        );
      }
    }
    expect(toHex(rootFrom(stored, 0))).toBe(toHex(rootOf([])));
  });

  it("reads only O(log n) nodes, all of them complete", () => {
    const needed = nodesNeeded((get) => {
      rootFrom(get, 69);
      inclusionPathFrom(get, 40, 69);
    });
    expect(needed.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(69)) + 2);
    for (const [level, index] of needed) expect((index + 1) * 2 ** level).toBeLessThanOrEqual(69);
  });

  it("knows which nodes each append completes", () => {
    expect(nodesCompletedBy(0)).toEqual([[0, 0]]);
    expect(nodesCompletedBy(1)).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(nodesCompletedBy(7)).toEqual([
      [0, 7],
      [1, 3],
      [2, 1],
      [3, 0],
    ]);
    expect(nodesCompletedBy(10)).toEqual([[0, 10]]);
  });
});
