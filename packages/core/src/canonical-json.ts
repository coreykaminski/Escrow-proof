/**
 * Deterministic JSON serialization (RFC 8785-style): object keys sorted, no whitespace.
 * Anything we hash must go through this so the same value always yields the same bytes.
 * Throws on values JSON can't represent faithfully (undefined in arrays, NaN, Infinity,
 * bigint, Date, class instances) instead of silently coercing them.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((item, i) => {
        if (item === undefined) {
          throw new TypeError(`canonicalJson: undefined array element at ${path}[${i}]`);
        }
        return serialize(item, `${path}[${i}]`);
      })
      .join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `canonicalJson: only plain objects are allowed at ${path} (got ${proto?.constructor?.name})`,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`).join(",")}}`;
}
