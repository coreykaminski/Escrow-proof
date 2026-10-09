# Public verdict records (`verdict/1`) and ledger proofs

Proof Desk publishes every final live verdict as a **content-free record**. Anyone can collect and verify the records, for example to fold them into their own transparency log, without learning who transacted, what the job was, or how much it was for.

## The record
```json
{
  "v": "verdict/1",
  "kind": "verdict",
  "subject": "<sha256 of salt ':' agreement_id, hex>",
  "outcome": { "kind": "release" | "refund" | "partial", "release_percent": 40 },
  "decided_by": "auto" | "human",
  "final_on": "2026-10-09"
}
```
- **`subject`** is a salted digest. The 32-byte random salt goes only to the agreement's parties, inside their proof bundle. Without it the record can't be linked to anything.
- **No content is hashed into the record:** no title, criteria, amount, names or document hashes.
- **Time is the UTC day only.** Records are sealed in a daily batch that shares one timestamp, in shuffled order.

## Where it lives
- Each record is its own ledger entry (`verdict.sealed`, no agreement id). So it's a leaf of the ledger's Merkle tree (RFC 6962): leaf i is entry seq i+1, and the leaf data is that entry's 32-byte hash.
- The tree head (size, root) is anchored on-chain daily in `LedgerAnchor`.
- **Feed:** `GET /verdicts.json?after=<seq>&limit=<n>` returns records, each with its ledger entry fields, `leaf_index` and an inclusion proof, plus the tree head and its on-chain anchor.
- **Tree heads:**
  - `GET /ledger/checkpoint.json`: the current and last anchored tree heads.
  - `GET /ledger/consistency.json?from=&to=`: a proof that a later head extends an earlier one.

## Verifying
1. **Entry hash:** `sha256(canonical_json({seq, prevHash, agreementId: null, type, payload, createdAt}))` must equal `entry_hash`.
2. **Inclusion:** check it with the RFC 9162 §2.1.3.2 algorithm against the tree head. The leaf hash is `sha256(0x00 || entry_hash_bytes)`.
3. **Anchor:** the tree head must be posted on-chain: `LedgerAnchor.get(i)` returns `seq == size` and `headHash == root`.
4. **For a party:** `GET /v1/agreements/:id/proof` (or "download the proof" on the verdict report) returns the agreement's entries, the sealed record and the salt. `npm run verify-proof -- proof.json --rpc <url>` checks all of the above, and that the record's subject and outcome match the agreement's final decision.

Code: `packages/core/src/{merkle,ledger-proof,verdict}.ts`.
