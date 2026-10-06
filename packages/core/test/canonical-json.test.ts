import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json.ts";
import { hashValue } from "../src/hash.ts";

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("produces the same hash regardless of key insertion order", () => {
    expect(hashValue({ x: 1, y: "two", z: [3] })).toBe(hashValue({ z: [3], y: "two", x: 1 }));
  });

  it("omits undefined object properties like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("escapes strings exactly like JSON", () => {
    expect(canonicalJson({ s: 'quote " and \n newline and ü' })).toBe(
      JSON.stringify({ s: 'quote " and \n newline and ü' }),
    );
  });

  it.each([
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["undefined in array", [1, undefined]],
    ["bigint", { n: 1n }],
    ["Date", { d: new Date(0) }],
    ["Map", { m: new Map() }],
    ["function", { f: () => 1 }],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
