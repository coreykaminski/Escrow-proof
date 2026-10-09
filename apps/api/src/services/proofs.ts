/**
 * Merkle proofs over the ledger (RFC 6962): tree heads, inclusion proofs for one agreement's
 * entries, and consistency proofs between tree heads. The daily anchor posts a tree head
 * on-chain, so a party can check their verdict offline against the chain, with no other
 * agreement's entries and without trusting Proof Desk's database.
 */
import {
  consistencyPath,
  inclusionPath,
  type LedgerProof,
  MERKLE_SCHEME,
  rootOf,
  toHex,
} from "@proofdesk/core";
import { type Db, ledgerLeaves, listLedgerForAgreement, schema } from "@proofdesk/db";
import { desc } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import { lastAnchor } from "./anchoring.ts";

export async function headSize(db: Db): Promise<number> {
  const [head] = await db
    .select({ seq: schema.ledgerEntries.seq })
    .from(schema.ledgerEntries)
    .orderBy(desc(schema.ledgerEntries.seq))
    .limit(1);
  return head?.seq ?? 0;
}

export async function treeHead(db: Db, size?: number) {
  const leaves = await ledgerLeaves(db, size);
  return { scheme: MERKLE_SCHEME, size: leaves.length, root: toHex(rootOf(leaves)) };
}

/**
 * Proof of an agreement's entries against the latest anchored tree head when it covers them
 * all, otherwise against the current (not yet anchored) head.
 */
export async function ledgerProof(db: Db, agreementId: string): Promise<LedgerProof> {
  const entries = await listLedgerForAgreement(db, agreementId);
  const last = entries.at(-1);
  if (!last) throw new ApiError(404, "not_found", "no ledger entries for this agreement");
  const anchor = await lastAnchor(db);
  const anchored = anchor && anchor.seq >= last.seq ? anchor : null;
  const size = anchored ? anchored.seq : await headSize(db);
  const leaves = await ledgerLeaves(db, size);
  const root = toHex(rootOf(leaves));
  if (anchored?.root && anchored.root !== root) {
    throw new ApiError(500, "ledger_mismatch", "the ledger no longer matches its anchored root");
  }
  return {
    object: "ledger_proof",
    scheme: MERKLE_SCHEME,
    agreement_id: agreementId,
    tree: {
      size,
      root,
      anchor: anchored
        ? {
            chain_id: anchored.chain_id,
            contract: anchored.contract,
            tx_hash: anchored.tx_hash,
            anchored_at: anchored.at.toISOString(),
          }
        : null,
    },
    entries: entries.map((e) => ({
      seq: e.seq,
      prev_hash: e.prevHash,
      type: e.type,
      payload: e.payload,
      created_at: e.createdAt,
      entry_hash: e.entryHash,
      leaf_index: e.seq - 1,
      inclusion: inclusionPath(leaves, e.seq - 1).map(toHex),
    })),
  };
}

/** Proof that the tree head of size `to` extends the one of size `from`. */
export async function consistencyProof(db: Db, from: number, to: number) {
  const size = await headSize(db);
  if (!(from >= 1 && from <= to && to <= size)) {
    throw new ApiError(400, "validation_error", `need 1 ≤ from ≤ to ≤ ${size}`);
  }
  const leaves = await ledgerLeaves(db, to);
  return {
    object: "consistency_proof",
    scheme: MERKLE_SCHEME,
    from: { size: from, root: toHex(rootOf(leaves.slice(0, from))) },
    to: { size: to, root: toHex(rootOf(leaves)) },
    proof: consistencyPath(leaves, from).map(toHex),
  };
}
