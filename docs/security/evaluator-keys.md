# Evaluator key custody and rotation

On the stablecoin rail, Proof Desk never holds funds. But the **evaluator key** decides where every on-chain job's money goes: to the job's provider or back to its client. Whoever holds it can settle any open job either way. It is the trust root of the rail, and this policy treats it that way.

## Roles: one key each
| Role | Power | Gas | Where |
|---|---|---|---|
| **Evaluator** | Settles jobs: `settle` on ProofDeskJobs, `complete`/`reject` on any ERC-8183 job naming it | yes | KMS (`EVALUATOR_KMS_KEY_ID`) |
| **Relayer** | None over funds. Submits buyers' signed EIP-3009 authorizations; relaying is permissionless | yes | KMS (`RELAYER_KMS_KEY_ID`) |
| **Anchorer** | Posts ledger tree heads to LedgerAnchor (forward-only; can't touch funds) | yes | KMS (`ANCHOR_KMS_KEY_ID`) |
| **Owner** | ProofDeskJobs: fee (capped at 5%) and treasury; LedgerAnchor: rotates the anchorer. Can't move job funds or change a job's evaluator | rarely | **Multisig** (e.g. a Safe), never a server key |

## Rules
- **Base mainnet: KMS keys only.**
  - The server refuses to start on chain 8453 if any role uses a raw private key, or if two roles share a KMS key (`assertKeyPolicy`).
  - `ALLOW_HOT_KEYS=1` overrides this for incident break-glass only, and its use is logged in the incident record.
- **Signing happens inside the KMS.** `remoteAccount` sends 32-byte digests to KMS `Sign` (ECDSA_SHA_256, `MessageType=DIGEST`). It normalizes signatures to low-s and recovers the parity. Key material never reaches the server.
- **Least privilege:**
  - The server's IAM role may only call `kms:Sign` and `kms:GetPublicKey` on these three key ARNs.
  - Key deletion and policy changes need a separate administrator role with MFA.
  - CloudTrail logs every `Sign` call.
- **Exposure is bounded.**
  - Live jobs above $5,000 can't be funded at all (`PRICING.directHoldMaxCents`).
  - Every settlement's on-chain `reason` is the decision's ledger hash, so any settlement without a matching ledger decision is detectable. The ledger is anchored daily.
- **Deploys:** on mainnet, `Deploy.s.sol` and `DeployAnchor.s.sol` refuse to run unless `OWNER` is a contract (the multisig) other than the deployer. The treasury and token must be explicit.

## Rotation
- Each job records its evaluator when it's funded, and the contract never changes it. So a rotation applies to new jobs only, and **the old key must stay available until every job funded under it is settled or expired.** The longest job lifetime is the delivery deadline + 1 day + appeal window + 7 days.
- **Steps:**
  1. Create the new KMS key.
  2. Point `EVALUATOR_KMS_KEY_ID` at it on a second worker deployment that serves only new agreements.
  3. Keep one worker on the old key until its last job closes.
  4. Disable the old key, then schedule its deletion.
- A server asked to settle a job funded under another key refuses with `409 evaluator_key_mismatch`, naming the job's evaluator.
- **Anchorer:** the LedgerAnchor owner (the multisig) calls `setAnchorer(new)`.
- **Relayer:** swap it any time; it holds no power over funds.
- **Rotate after:** any suspected exposure; anyone with KMS admin rights leaving; and at least yearly.

## If the evaluator key is suspected compromised
1. Stop the worker (no settlements). Disable the KMS key; that ends all signing at once.
2. Use CloudTrail `Sign` calls and the chain to list settlements since the last known-good time. Any `reason` hash without a matching ledger decision was made by the attacker.
3. Open jobs can't be settled by anyone else. After expiry the buyers can always reclaim. Tell affected platforms which jobs will refund on expiry.
4. Deploy a new evaluator key for new jobs and publish the incident.

## Later
Threshold or MPC signing (no single key holder) and a contract-level guardian are options before high volume on mainnet. Both need a vendor and design decision, and are outside this policy. The contract audit should review this document together with `ProofDeskJobs.settle`.
