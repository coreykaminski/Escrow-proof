import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash of a JSON-compatible value via its canonical serialization. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
