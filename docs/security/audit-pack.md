# Audit and penetration-test pack

For the smart-contract auditor and the penetration testers: what to look at, what we claim, the evidence, and what we already know. Everything here is reproducible from the repository.

---

## Part A: smart-contract audit

### Scope
| File | Lines | What it does |
|---|---|---|
| `contracts/src/ProofDeskJobs.sol` | 400 | ERC-8183 job contract for one stablecoin (USDC on Base): clients fund jobs, the evaluator settles them, and the client can always reclaim after expiry. |
| `contracts/src/LedgerAnchor.sol` | 70 | Append-only, forward-only record of the off-chain ledger's Merkle tree heads. |
| `contracts/src/IERC8183.sol` | 70 | The standard interface. |
| `contracts/script/Deploy.s.sol`, `DeployAnchor.s.sol` | | Deployment, including the mainnet owner checks. |

- **Compiler:** Solidity 0.8.30, `via_ir = true`, optimizer 10,000 runs, no upgradeability or proxies.
- **Out of scope:** `src/test/*`, a mock USDC and a plain reference ERC-8183 implementation used only in tests.

### Roles and trust
| Role | Can | Can't |
|---|---|---|
| **Client** (buyer) | Create and fund jobs; reject while still Open; reclaim after expiry (`claimRefund`, callable by anyone) | Take funds back early, or after a decision |
| **Provider** (seller) | Set the budget while Open; submit | Get paid without the evaluator |
| **Evaluator** (Proof Desk; per job, fixed at creation) | `complete`, `reject`, or `settle(jobId, releaseBP, reason)`, only before expiry for releases, once per job | Send funds anywhere but the job's own provider, client and the treasury fee; act on another evaluator's jobs |
| **Owner** (multisig; enforced on mainnet by the deploy script) | Set the fee (≤ 5%, **snapshotted per job at creation**), treasury, ownership | Move job funds; change a job's evaluator, parties, budget or fee |
| **Treasury** | Receive the fee on released amounts | Anything else |

The evaluator key is the trust root; custody and rotation are covered in [evaluator-keys.md](evaluator-keys.md). Proof Desk never holds funds; that's a legal requirement as well as a design choice.

### Properties we claim (each is tested)
| # | Property | Evidence |
|---|---|---|
| P1 | **Funds conserved:** contract balance = sum of funded, unsettled budgets; every settlement pays exactly `budget` out | `invariant_fundsConserved` |
| P2 | **Only a job's evaluator decides it** | `invariant_onlyEvaluatorDecides`, unit tests |
| P3 | **No payment to the provider after expiry** | `invariant_noPaymentAfterExpiry` |
| P4 | **Expired, undecided jobs are always refundable** to the client by anyone | `invariant_expiredJobsAlwaysRefundable` |
| P5 | A gasless-funding signature funds only the exact terms signed (nonce = hash of chain, contract, parties, expiry, description, budget) | unit tests, plus the TypeScript/contract nonce equality test on anvil |
| P6 | The fee can't exceed 5% and can't change for an existing job | unit and guard tests |
| P7 | Fee-on-transfer, false-returning and reentrant tokens can't corrupt accounting; USDT-style no-return tokens work | `ProofDeskJobs.guards.t.sol` |
| P8 | LedgerAnchor is forward-only (seq strictly increases, never 0 or an empty hash), and only the anchorer posts | `LedgerAnchor.t.sol` (unit and fuzz) |

- **Invariant runs:** 256 runs × depth 64 locally, 512 × 128 in CI (`FOUNDRY_PROFILE=ci`).
- **Fuzz:** 2,000 runs.
- **Total:** 37 Foundry tests, all passing.

### Coverage (`forge coverage --ir-minimum`)
| Contract | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| ProofDeskJobs.sol | 94.6% | 94.2% | 86.8% | 96.0% |
| LedgerAnchor.sol | 79.3% | 78.4% | 66.7% | 85.7% |

The branches still reported as missed:
- **Exercised by tests, but not counted.** `forge coverage` doesn't count hits inside reverted call frames:
  - constructor argument checks (`test_constructor_rejectsZeroAddressesAndExcessiveFee`);
  - the reentrancy guard firing during a payout (`test_reentrancyDuringPayout_isBlocked` asserts the `Reentrancy` selector);
  - `LedgerAnchor.setAnchorer(0)` (`test_ledgerAnchor_rejectsZeroAddresses`).
- **Defensive and unreachable in practice:** `_call`'s "token has no code" check. A token must have code to pass `balanceOf` before any transfer.

### Static analysis (Slither 0.11.6, 81 detectors, production contracts only)
| Finding | Our assessment |
|---|---|
| `reentrancy-balance` ×2 (`_pull`, `createAndFundWithAuthorization`): balance read before and after a token call | **False positive here.** The token is fixed at deployment (immutable USDC), and every token-moving entry point is `nonReentrant`. The before/after check is a guard *against* fee-on-transfer tokens, proven by `test_feeOnTransferTokens_areRefused`. Worth an auditor's look anyway. |
| `divide-before-multiply` in `_payOut` (fee = rounded `released` × feeBP / 10,000) | **Intentional.** The fee applies to the released amount. Rounding differs by at most 1 base unit (0.000001 USDC) and favours the provider; `toProvider + toClient + fee == budget` exactly (P1). |
| `timestamp` ×8 | **Accepted.** Expiries are hours to days; block-time drift is seconds. |

### Known limitations and design decisions (please confirm or challenge)
1. **Token blacklisting:** if USDC blacklists the provider, a release reverts. The job then stays open until expiry, when the client can reclaim (P4). The evaluator can also choose to reject. Funds can only be stuck if *both* parties are blacklisted.
2. **Hooks are unsupported:** `hook` must be `address(0)`. External ERC-8183 contracts with hooks aren't attached by the API either.
3. **Our extensions to the standard:** `settle(jobId, releaseBP, reason)` for partial outcomes, `createAndFund` and `createAndFundWithAuthorization` (EIP-3009), and the per-job fee snapshot.
4. **`reason`:** for settlements made by the API, `reason` is the ledger entry hash of the decision. It isn't validated on-chain; it links each settlement to the off-chain, anchored ledger.
5. **The description string is unbounded;** its length costs the caller gas only.
6. **No pause or guardian:** a deliberate choice to keep the owner powerless over funds. The open question for the audit is whether a time-locked guardian is worth adding before high volume.

### Reproduce
```bash
cd contracts
forge test                                   # 37 tests
FOUNDRY_PROFILE=ci forge test                # deeper invariants
forge coverage --ir-minimum --report summary
slither . --filter-paths "lib/|test/|script/|src/test/" --exclude-informational
```
The TypeScript side (`packages/chain`) has an anvil integration test, `npm test`. It deploys these contracts and drives funding, settlement, the reference ERC-8183 contract and a KMS-style signer.

---

## Part B: penetration test

### Scope
- **The API service:** `apps/api`, a single process. It serves:
  - the REST API (`/v1/*`);
  - the dashboard (`/dashboard/*`);
  - the public pages (`/r/:token`, `/pay/:token`, `/embed/*`, `/signup`, `/status`, `/pricing`, `/accuracy`, `/verdicts.json`, `/ledger/*`, `/.well-known/*`);
  - A2A (`/a2a/*`) and the Stripe webhook (`/webhooks/stripe`).
- **The worker** (scheduler) and **the code sandbox host** (Docker plus gVisor, separate VM).
- **Out of scope:** Stripe, Anthropic, Base and Fly infrastructure themselves.

**Test accounts:** we provide sandbox keys of every scope:
- `platform`: full platform API;
- `verify`: Verify API, A2A and templates only;
- `ops`: Proof Desk staff;
- a self-serve sandbox key (`/signup`).

Live mode isn't in scope until legal sign-off.

### What we'd most like attacked
1. **Cross-account access:** reading or acting on another platform's agreements, keys, webhooks, events, billing or verifications. Every query is account-scoped; cross-account requests should return 404.
2. **Authorization:**
   - `verify` keys reaching agreements or money;
   - test keys acting on live agreements;
   - key creation escalating scopes;
   - revoked or expired keys or sessions still working.
3. **Getting paid for bad work:**
   - prompt injection inside deliverables (translation, data, research);
   - code deliverables that tamper with the buyer's tests or the runner. Results are signed by a trusted runner with a per-run key.
4. **Escaping the code sandbox:** network, filesystem, process limits, timing.
5. **SSRF:**
   - webhook URLs, research citations and source fetching should only reach public addresses;
   - this is checked at connect time, which also blocks DNS rebinding.
6. **Money paths:**
   - double settlement, settling before the appeal window or during a pending review;
   - idempotency-key reuse;
   - Stripe webhook forgery or replay;
   - shared payment token misuse;
   - funding over the $5,000 live limit.
7. **Public tokens and pages:**
   - share-link and payment-link tokens (192-bit, hashed, expiring);
   - the embed widget, the only framable page;
   - CSP;
   - sign-up rate limits and sandbox quotas.
8. **Ledger integrity:**
   - making an entry, proof or verdict record disagree with the anchored Merkle root;
   - extracting identifying data from `/verdicts.json` or proof bundles.

### Controls already in place, and earlier internal reviews
- **Reviews:**
  - [review-2026-10.md](review-2026-10.md): an internal security review, by trust boundary.
  - [red-team.md](red-team.md): the adversarial catalog and its tests.
  - [evaluator-keys.md](evaluator-keys.md): key custody.
- **Automated in CI:** CodeQL (`security-extended`), gitleaks over full history, `npm audit` of production dependencies, Dependabot, SHA-pinned Actions.
- **Tests:** 739 API and unit tests (on PGlite and on real Postgres), 7 browser tests, Python SDK tests, 37 contract tests.

### Rules of engagement
- Test against staging only, with the provided keys.
- Don't run volumetric DoS. The rate limits are in scope, but flooding isn't.
- Report findings to Corey. Each fix comes with a regression test, the same rule as the red-team catalog.
