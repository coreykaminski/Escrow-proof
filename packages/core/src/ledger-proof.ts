import { computeEntryHash } from "./ledger.ts";
import { fromHex, ledgerLeaf, MERKLE_SCHEME, verifyInclusion } from "./merkle.ts";
import { type VerdictRecord, verdictSubject } from "./verdict.ts";

interface ProvedEntry {
  seq: number;
  prev_hash: string;
  type: string;
  /** Canonical JSON, exactly as hashed. */
  payload: string;
  created_at: string;
  entry_hash: string;
  leaf_index: number;
  inclusion: string[];
}

/**
 * A self-contained proof that an agreement's ledger entries are in a ledger tree head, which
 * anyone can check offline: recompute each entry's hash from its fields, then its inclusion in
 * the tree (RFC 6962). Comparing the tree head with the on-chain anchor is the last step
 * (scripts/verify-proof.ts does it given an RPC URL).
 */
export interface LedgerProof {
  object: "ledger_proof";
  scheme: typeof MERKLE_SCHEME;
  agreement_id: string;
  tree: {
    size: number;
    root: string;
    /** Where this tree head was posted on-chain; null if it isn't anchored yet. */
    anchor: { chain_id: number; contract: string; tx_hash: string; anchored_at: string } | null;
  };
  entries: ProvedEntry[];
  /**
   * The agreement's public, content-free verdict record (once sealed) and the salt that links
   * it to this agreement. Only the parties get the salt.
   */
  verdict?: { salt: string; entry: ProvedEntry };
}

/** The final outcome the agreement's own ledger entries record, in verdict-record form. */
function finalOutcome(entries: ProvedEntry[]): VerdictRecord["outcome"] | null {
  let out: VerdictRecord["outcome"] | null = null;
  for (const e of entries) {
    const payload = JSON.parse(e.payload) as { outcome?: VerdictRecord["outcome"] | null };
    if (e.type === "agreement.miss_deadline") out = { kind: "refund" };
    else if (
      ["agreement.decide", "agreement.resolve_dispute", "agreement.review"].includes(e.type) &&
      payload.outcome
    ) {
      out = payload.outcome;
    }
  }
  return out;
}

export function verifyLedgerProof(p: LedgerProof): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (p.scheme !== MERKLE_SCHEME) problems.push(`unknown scheme ${p.scheme}`);
  let root: Uint8Array;
  try {
    root = fromHex(p.tree.root);
  } catch {
    return { ok: false, problems: ["tree root isn't hex"] };
  }
  if (p.entries.length === 0) problems.push("no entries");
  const check = (e: ProvedEntry, agreementId: string | null) => {
    const computed = computeEntryHash({
      seq: e.seq,
      prevHash: e.prev_hash,
      agreementId,
      type: e.type,
      payload: e.payload,
      createdAt: e.created_at,
    });
    if (computed !== e.entry_hash) problems.push(`entry ${e.seq}: content doesn't match its hash`);
    if (e.leaf_index !== e.seq - 1) problems.push(`entry ${e.seq}: wrong leaf index`);
    let ok = false;
    try {
      ok = verifyInclusion(
        ledgerLeaf(e.entry_hash),
        e.leaf_index,
        p.tree.size,
        e.inclusion.map(fromHex),
        root,
      );
    } catch {
      ok = false;
    }
    if (!ok) problems.push(`entry ${e.seq}: not in the tree head (inclusion proof fails)`);
  };
  for (const e of p.entries) check(e, p.agreement_id);

  if (p.verdict) {
    const v = p.verdict;
    check(v.entry, null);
    const record = JSON.parse(v.entry.payload) as VerdictRecord;
    if (v.entry.type !== "verdict.sealed") problems.push("verdict entry has the wrong type");
    if (record.subject !== verdictSubject(v.salt, p.agreement_id)) {
      problems.push("the verdict record's subject isn't this agreement (salt mismatch)");
    }
    const expected = finalOutcome(p.entries);
    if (JSON.stringify(record.outcome) !== JSON.stringify(expected)) {
      problems.push("the verdict record's outcome differs from the agreement's final decision");
    }
  }
  return { ok: problems.length === 0, problems };
}
