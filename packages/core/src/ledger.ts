import { canonicalJson } from "./canonical-json.ts";
import { sha256Hex } from "./hash.ts";

/**
 * Tamper-evident decision ledger: a single global hash chain. Each entry's hash covers its own
 * content plus the previous entry's hash, so editing, deleting or reordering any entry breaks
 * every hash after it. (Truncating the tail is caught by comparing against a published/anchored
 * head hash; on-chain anchoring is a later part.)
 */

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEntryBody {
  seq: number;
  prevHash: string;
  agreementId: string | null;
  type: string;
  /** Canonical JSON string; stored verbatim so verification never depends on JSON re-encoding. */
  payload: string;
  /** UTC ISO-8601 with milliseconds. */
  createdAt: string;
}

export interface LedgerEntry extends LedgerEntryBody {
  entryHash: string;
}

export function computeEntryHash(body: LedgerEntryBody): string {
  return sha256Hex(
    canonicalJson({
      seq: body.seq,
      prevHash: body.prevHash,
      agreementId: body.agreementId,
      type: body.type,
      payload: body.payload,
      createdAt: body.createdAt,
    }),
  );
}

export function buildEntry(
  prev: { seq: number; entryHash: string } | null,
  input: { agreementId: string | null; type: string; payload: unknown; createdAt: Date },
): LedgerEntry {
  const body: LedgerEntryBody = {
    seq: prev ? prev.seq + 1 : 1,
    prevHash: prev ? prev.entryHash : GENESIS_HASH,
    agreementId: input.agreementId,
    type: input.type,
    payload: canonicalJson(input.payload),
    createdAt: input.createdAt.toISOString(),
  };
  return { ...body, entryHash: computeEntryHash(body) };
}

export type ChainVerification =
  | { ok: true; count: number; headSeq: number; headHash: string }
  | { ok: false; seq: number; reason: string };

/**
 * Incremental verifier, so large chains can be checked page by page.
 * `push` returns a failure as soon as one is found, otherwise null; `result` gives the summary.
 */
export function createChainVerifier() {
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;

  return {
    push(e: LedgerEntry): ChainVerification | null {
      if (e.seq !== expectedSeq) {
        return { ok: false, seq: e.seq, reason: `expected seq ${expectedSeq}, found ${e.seq}` };
      }
      if (e.prevHash !== prevHash) {
        return { ok: false, seq: e.seq, reason: "prev_hash does not link to the previous entry" };
      }
      if (computeEntryHash(e) !== e.entryHash) {
        return { ok: false, seq: e.seq, reason: "entry content does not match its hash" };
      }
      prevHash = e.entryHash;
      expectedSeq++;
      return null;
    },
    result(): ChainVerification {
      return { ok: true, count: expectedSeq - 1, headSeq: expectedSeq - 1, headHash: prevHash };
    },
  };
}

/** Verify a full chain from genesis. `entries` must be every entry, ordered by seq. */
export function verifyChain(entries: Iterable<LedgerEntry>): ChainVerification {
  const verifier = createChainVerifier();
  for (const e of entries) {
    const failure = verifier.push(e);
    if (failure) return failure;
  }
  return verifier.result();
}
