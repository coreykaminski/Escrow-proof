import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIXES = {
  account: "acct",
  apiKey: "key",
  agreement: "agr",
  delivery: "dlv",
  decision: "dec",
  dispute: "dsp",
  input: "inp",
  verification: "ver",
  seller: "sel",
  hold: "hld",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32 (26 chars, time-sortable). */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[(bytes[i] as number) % 32];
  }
  return time + rand;
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}
