import { computeEntryHash } from "./ledger.ts";
import { fromHex, ledgerLeaf, MERKLE_SCHEME, verifyInclusion } from "./merkle.ts";

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
  entries: {
    seq: number;
    prev_hash: string;
    type: string;
    /** Canonical JSON, exactly as hashed. */
    payload: string;
    created_at: string;
    entry_hash: string;
    leaf_index: number;
    inclusion: string[];
  }[];
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
  for (const e of p.entries) {
    const computed = computeEntryHash({
      seq: e.seq,
      prevHash: e.prev_hash,
      agreementId: p.agreement_id,
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
  }
  return { ok: problems.length === 0, problems };
}
