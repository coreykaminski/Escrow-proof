# Hiring Proof Desk as the evaluator of an ERC-8183 job

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) jobs have three roles: a **client** funds the job, a **provider** does the work, and an **evaluator** decides.
- `complete` pays the provider.
- `reject` refunds the client.
- After expiry, anyone can return the money to the client.

Proof Desk can be the evaluator of a job on **any** standard ERC-8183 contract, not just its own. It checks the delivery against acceptance criteria both sides approved before funding, then calls `complete` or `reject`.

Proof Desk never holds the funds. Under the standard, the evaluator can only send them to the job's own provider or client.

Discovery: `GET /.well-known/erc8183-evaluator.json` lists:
- the evaluator address and chain;
- the verticals it can check;
- prices;
- these steps.

## Steps
1. **Agree the criteria.** Create an agreement in USDC with the acceptance criteria: `POST /v1/agreements` (attach inputs, then `POST /v1/agreements/{id}/approve-spec`).
2. **Read the terms.** `GET /v1/agreements/{id}/external-job/terms` returns:
   - `evaluator`: the address to name in the job;
   - `token` and `budget`: the job must hold exactly this amount of this token;
   - `description_must_contain`: `proofdesk:v1:<agreement id>:<spec hash>`, so the client's own transaction commits to the approved criteria;
   - `min_expired_at` (and `recommended_expired_at`): enough time to verify and to hear an appeal before the client can reclaim.
3. **Create and fund the job** on your ERC-8183 contract with those terms, with no hook.
4. **Attach it:** `POST /v1/agreements/{id}/external-job` with `{ "contract": "0x…", "job_id": "42" }`.
   - Proof Desk reads the job from the chain and checks: our evaluator, the exact budget, `paymentToken()` equals the agreed token, the description tag, the expiry, no hook, a provider set.
   - A mismatch returns `422 terms_mismatch` listing every problem.
   - A job attached after the delivery deadline is rejected straight away, so the client gets the money back.
5. **Deliver.**
   - Send the work to Proof Desk: `POST /v1/agreements/{id}/deliveries`.
   - The provider also calls `submit(jobId, deliverableHash, "")` on the job contract. The standard only lets the evaluator `complete` a submitted job.
6. **Decision and settlement.**
   - Proof Desk verifies the delivery and decides (or escalates to a human).
   - After the appeal window it calls `complete` (release) or `reject` (refund).
   - The `reason` passed on-chain is the decision's ledger entry hash, so the on-chain call and the decision can be matched.

## Differences from Proof Desk's own contract
| | ProofDeskJobs (native) | Any ERC-8183 contract (external) |
|---|---|---|
| Partial outcomes | Yes (`settle` with a release share) | No: `complete` or `reject` only. A partial verdict goes to a human, who picks one. |
| Gasless funding (EIP-3009), x402 | Yes | Whatever that contract offers |
| Conditional payment fee | Taken by the contract | None. Verification and dispute fees are invoiced monthly. |
| Provider must `submit` before release | No | Yes |
| Hooks | n/a | Not supported |

## Failure modes
- **Provider never submits:**
  - A release can't settle (`provider_not_submitted` shows in the scheduler's errors).
  - If the job expires first, the client can reclaim the funds. Proof Desk records it (`onchain_job.expired`).
- **The contract's `paymentToken()` is missing or different:** the job can't be attached.
- **Custom errors of the contract** aren't in the standard ABI, so reverts surface as a generic `reverted` (still non-retryable).

Tested against a plain reference implementation (`contracts/src/test/ReferenceERC8183.sol`) on a local chain: `packages/chain/test/anvil.test.ts`. The API flow is tested in `apps/api/test/external-jobs.test.ts`.
