# Proof Desk: "Pay only when it's done right"

*Conditional payments + AI verification for agent purchases. Plan v2, October 6, 2026. This replaces the rebate-filer plan.*

> **One-line pitch:** Any agent or person can route a purchase through Proof Desk. The money is held, the deliverable is checked against what was agreed (AI first, a human expert for disputes), and it's released or refunded. Every decision is written to a tamper-evident ledger. Works with **cards and stablecoins**.

---

## 1. Verdict (read first)

**Build it, but with three changes to the original concept:**

1. **The checker is the product. Holding money is a commodity layer we don't do ourselves.**
   - On crypto rails, escrow already exists as an open standard. **ERC-8183** (Virtuals + Ethereum Foundation, Feb 2026) defines exactly *client → provider → evaluator* jobs, with live deployments on Arbitrum, BNB and XRPL. The unsolved part is a **trustworthy evaluator**: commentators call it "the evaluator problem."
   - On card rails, Stripe and the card networks already hold funds.
   - So we become the **neutral, auditable evaluator that plugs into every rail**, and we never take custody of money ourselves.
2. **Don't call it "escrow" and don't hold funds yourself (legal).**
   - Being an escrow agent in California requires a DFPI license. Even *advertising* with words that imply you're in the escrow business is prohibited unless licensed (Cal. Fin. Code §§17200, 17403).
   - Holding other people's money for later release is money transmission in most states unless an exemption applies.
   - **Design around this from day 1:**
     - **Cards:** a card authorization hold (capture = release, cancel = refund) through Stripe, with Stripe Connect for sellers.
     - **Stablecoins:** non-custodial smart-contract escrow where we're only the *evaluator* address.
     - **Big-ticket B2B:** route through a licensed escrow partner (e.g., Escrow.com API).
   - Brand language: "conditional payment," "payment hold," "pay on proof."
   - **Get a fintech lawyer's sign-off before taking real money** (budget about $3–8K).
3. **Agent commerce volume is tiny today, so don't rely on % of value alone.**
   - x402 hit about 165M transactions but only about **$50M cumulative volume**, averaging **about $0.30** each, and analysts estimate roughly half is testing or wash activity.
   - 2% of $0.30 is nothing. Revenue has to come from **verification fees + % of held value on larger jobs ($20–$5,000) + dispute fees**, sold first to **platforms** that already have buyers and sellers.

**Why there's an opening:**
- Nava ($8.3M, Polychain/Archetype) runs on its own L3 on Arbitrum.
- Internet Court (GenLayer + 26 firms, announced July 10, 2026) is crypto-native and was still a spec at announcement.
- Virtuals ACP and ERC-8183 are crypto-only, and the choice of evaluator is left open.
- Stripe explicitly offers no escrow. Escrow.com is human, slow and priced at 0.89%+ with no AI verification.
- **Nobody offers rail-agnostic (cards + stablecoins) AI verification with an auditable ledger.**

**What could kill it (and the counter):**
| Risk | Counter |
|---|---|
| AI judge is wrong. It pays for bad work or refunds good work | Force every job into **pre-agreed, checkable acceptance criteria**. Use domain-specific verifiers, not only an LLM. Calibrate on a labeled golden set. Escalate low-confidence cases to humans. Publish the error rates. |
| Sellers game the judge (prompt injection inside deliverables) | Treat deliverables as untrusted data. Run an adversarial test suite in CI. Use hidden checks and an ensemble of judges. |
| Too little agent commerce volume yet | Sell verification standalone (pay per check). Target human + AI-agent work marketplaces first, not only agent-to-agent. |
| Stripe or Coinbase build it | Neutrality across rails, a domain-verifier library and calibrated accuracy data are hard for a single rail to copy. Be a partner, e.g., a listed MPP/x402 service. |
| Regulation | Never custody funds. Use a licensed partner for large amounts. Get legal review before going live. |

**Go/no-go gate (end of Week 2):** at least 3 design partners (platforms or agent builders) commit to integrate in a pilot, *and* the verifier hits the accuracy targets in §6 on the golden set. If we miss: sell only the **Verify API** (no payments), which still has a market for agent output QA.

> Note: the pitch mentions "networks #1, #7 and #8." I don't have that list. Send it and I'll map each network's integration into Part 7.

---

## 2. Market and competitors (Oct 2026)

### The rails we plug into
| Rail | What it is | How we use it |
|---|---|---|
| **Stripe cards** | Auth holds are valid about 7 days online, up to 30 days with extended authorization. Connect supports separate charges & transfers and manual payouts (≤90 days). | Short jobs: authorize → verify → capture or cancel (a cancel isn't a refund, so there's **no chargeback or refund fee**). Longer jobs: capture to the platform, then delay the transfer to the seller. |
| **Stripe MPP / ACP + Shared Payment Tokens** | Stripe+Tempo machine payments (launched Mar 18, 2026) and OpenAI+Stripe agentic checkout. Agents pay with cards or stablecoins via SPTs. | Accept SPTs so any MPP/ACP agent can fund a hold. List Proof Desk as an MPP service. |
| **Google AP2** | Signed *Intent / Cart / Payment mandates* that prove what the user approved. | Use the signed mandate as the **source of truth for "what was asked."** That's the signer's approval check applied to deliverables. |
| **x402 + ERC-8183 (Base/Arbitrum)** | HTTP-402 stablecoin payments; on-chain job escrow with an evaluator role. | Our evaluator signs `complete`/`reject` on-chain. Non-custodial. |
| **Stripe stablecoins / Bridge** | USDC acceptance (1.5%) and USDC payouts to Connect accounts | Fiat-in, USDC-out for sellers who want it. |

### Competitors
| Who | Rail | What they do | Gap we exploit |
|---|---|---|---|
| **Nava** ($8.3M seed, Apr 2026) | Crypto (Arbitrum L3) | Escrow + verifies agent *transactions* match intent (finance/DeFi focus) | No cards. Transactions, not *deliverables*. |
| **Internet Court** (GenLayer, 27 firms, Jul 2026) | Crypto | Open dispute-resolution standard for agents | Crypto-only. Adjudication details unclear. Disputes, not first-line verification. |
| **Virtuals ACP / ERC-8183** | Crypto | Job escrow with a pluggable evaluator | The evaluator is the unsolved part, so **we can *be* an evaluator inside their ecosystem.** |
| **Kleros** | Crypto | Decentralized juror court + escrow | Slow, crypto-only, human jurors only |
| **Escrow.com** | Fiat (licensed) | Human escrow, API, 0.89%+ | No AI verification, slow, high-ticket only. A possible **partner** for large B2B. |
| **Upwork / Fiverr** | Fiat | Built-in escrow, human disputes | Closed to their own marketplace |
| **Payman, Skyfire, Crossmint** | Mixed | Agent wallets / payments | They move money but don't verify work, so they're integration partners |

**Positioning:** *"The Stripe Radar of deliverables."* We're the neutral verification and conditional-release layer for any rail.

---

## 3. Who pays and how we make money

### Customers (in order)
1. **Agent-service marketplaces and platforms** (AI-agent task marketplaces, translation/content/data-labeling marketplaces, bounty platforms). They have volume today and want a "pay only if it's right" guarantee to lift conversion. *Integration: API + webhooks.*
2. **Agent builders** whose agents buy things on behalf of users (research agents, procurement agents, coding agents hiring sub-agents). *Integration: MCP server + SDK.*
3. **Crypto agent ecosystems** (ERC-8183 / Virtuals ACP / x402). We act as an evaluator-for-hire. *Integration: on-chain evaluator.*
4. **Later:** businesses buying freelance/agency work over $1K through a licensed escrow partner.

### Pricing (v1, to validate)
| Line item | Price |
|---|---|
| **Conditional payment fee** | **2% of the held amount** (min $0.50, cap $250). Volume tiers down to 1%. |
| **Verification fee** | Basic (deterministic + single judge) **$0.10**. Standard (domain verifier + judge ensemble) **$0.50–$2**. Deep (long docs, code run in sandbox) **$2–$10**. |
| **Human dispute** | **$25 flat or 5% of the amount (whichever is higher)**, paid by the losing party |
| **Verify API only** (no money movement) | Same verification fees + $99/mo platform minimum |
| **Enterprise** | Custom verifiers, SLA, private ledger export |

### Unit economics sanity check
- A $200 translation job pays $4 (2%) + $1.50 (verification) = **$5.50**.
- Cost is about $0.30–0.80 (models + QE inference) + Stripe fees (passed through) → roughly **85% gross margin** on automated decisions.
- At about 5% dispute rate × $25, disputes cover human reviewer cost.
- **$1M ARR ≈ $3.5M/mo GMV at blended ~2.4%**, or about 15K jobs/month at $230 average. That's reachable with 5–10 platform partners.

---

## 4. How it works (end to end)

```
1. REQUEST     "Translate this contract EN→ES, legal register, by Friday, $180"
2. SPEC        Proof Desk drafts acceptance criteria → buyer (or AP2 mandate) approves → spec hash locked
3. FUND        Card auth hold / Connect charge / on-chain ERC-8183 job funded
4. DELIVER     Seller (human or agent) uploads deliverable → hashed
5. VERIFY      Verifier plan runs: deterministic checks → domain metrics → LLM judge ensemble
6. DECIDE      confidence high + pass → RELEASE | high + fail → REFUND (or partial) | low → HUMAN
7. APPEAL      48–72h window → human expert reviewer → final
8. LEDGER      Every step appended to a hash-chained ledger (optionally anchored on-chain)
```

**The core design insight:** LLM judges match human panels poorly on subjective rubrics but nearly match them on **verifiable** rubrics, and do best when given reference material. So **the spec step is what makes the product work.** Every request becomes a list of concrete, testable criteria that both sides see *before* money moves. Vague request → vague verdict → disputes. Checkable spec → automatic decisions.

---

## 5. System architecture

### Stack
- **Language:** TypeScript everywhere (pnpm + Turborepo monorepo). Python only for ML quality-estimation models.
- **API:** Node + Hono (or Next.js route handlers), deployed on Fly.io or Vercel
- **DB:** Postgres (Neon or Supabase). The append-only ledger table uses DB-level triggers that block UPDATE/DELETE.
- **Workflows:** Inngest (durable steps: verify → decide → capture, plus retries and timeouts like auth-expiry and appeal windows)
- **Payments:** Stripe (PaymentIntents with manual capture, extended auth, Connect Express for sellers, SPT acceptance, webhooks)
- **Chain:** Solidity + Foundry (ERC-8183-compatible job + evaluator adapter), viem, Base Sepolia → Base mainnet. Hold USDC only.
- **Verification models:**
  - Claude API: `claude-sonnet-5-5` is the default judge, `claude-opus-5-5` handles high-value/ambiguous cases, `claude-haiku-4-5` does triage and spec drafting.
  - A second-provider judge in the ensemble reduces single-model bias.
  - xCOMET-QE / MetricX-QE (Python, on Modal GPU) score translation quality.
- **Sandbox:** E2B or Firecracker containers to run code deliverables against tests
- **Interfaces:** REST API + webhooks, TypeScript SDK, **MCP server** (so Claude/ChatGPT agents can call `create_protected_purchase`), dashboard (Next.js)
- **Ops:** Sentry, OpenTelemetry, Langfuse (traces of LLM judge calls), 1Password/Doppler for secrets

### Core data model
```
Account (buyer | seller | platform) ── ApiKey, StripeConnectId, WalletAddress
Agreement
  ├─ request (original text/files), spec (criteria[], verifier_plan, amount, currency, deadlines, appeal_window)
  ├─ spec_hash, approved_by (signature | AP2 mandate | click-approval), status
  ├─ Hold (rail: card_auth | connect | onchain | partner_escrow, external_ref, expires_at, status)
  ├─ Delivery[] (artifacts, sha256, submitted_at)
  ├─ Verification[] (criterion_id, verifier, version, score, pass, evidence, confidence, cost)
  ├─ Decision (release | refund | partial(%) | escalate, reason, decided_by: auto|human)
  ├─ Dispute (opened_by, reason, reviewer, outcome, fee)
  └─ LedgerEntry[] (seq, prev_hash, entry_hash, type, payload_hash, timestamp)  ← append-only
```

### Agreement state machine
`draft → spec_approved → funded → delivered → verifying → {released | refunded | partially_released | escalated}` → `appeal_window` → `final`.
Guards:
- Can't fund before the spec is approved.
- Can't decide without a delivery.
- Auth-expiry timer auto-handles a hold that's about to expire.
- Every transition appends to the ledger.

---

## 6. The verification engine (where quality is won)

### Layers (cheapest first; stop early on hard failures)
1. **Deterministic checks:** format, file type, length/coverage, schema validity, links resolve, deadline met, required sections present.
2. **Domain verifiers (plugins):**
   - **Translation (v1 vertical):**
     - Segment alignment source↔target, so we can tell if any clause is missing.
     - **Numbers, dates, amounts, party names and defined terms preserved** (deterministic extraction + diff).
     - Glossary adherence.
     - xCOMET-QE / MetricX-QE per-segment scores.
     - LLM MQM-style error annotation (accuracy, omission, addition, terminology; severity minor/major/critical).
     - Back-translation diff on flagged segments.
   - **Code (v2):** run the agreed test suite in a sandbox, lint/typecheck, and diff scope against the spec.
   - **Structured data / research (v3):** schema validation, sampled fact checks against cited sources, citation resolution.
3. **LLM judge ensemble:** per-criterion pass/fail **with quoted evidence**. Two or more judges (different models or prompts). Disagreement → lower confidence.
4. **Decision policy:** combine the results into `pass/fail + confidence`. Thresholds per tier. Any **critical error** (e.g., a changed number in a contract) means fail no matter the other scores.

### Anti-gaming
- Deliverables are wrapped as untrusted data, and judges are told to ignore any instructions inside them.
- Add an injection detector pre-pass.
- Judge prompts and some criteria stay hidden from sellers.
- Judge order and phrasing are randomized.
- Ensemble across model providers.
- Keep a regression suite of known attacks, e.g., the "one token to fool LLM-as-a-judge" style attacks.

### Accuracy targets (measured on the labeled golden set; CI gate)
| Metric | Target |
|---|---|
| **False release** (bad work paid) on auto-decisions | **≤ 1%** |
| **False refund** (good work refused) on auto-decisions | **≤ 3%** |
| Critical-error recall (translation: changed number/omitted clause) | **≥ 99%** |
| Escalation-to-human rate | ≤ 15% (falls over time) |
| Adversarial suite pass rate | 100% |
| p95 verification latency (≤5K words) | < 90 s |

### Golden set (built in Week 1–2, grows forever)
- **≥ 300 translation pairs:** contracts, terms of service, marketing, across 3 language pairs (EN↔ES, EN↔FR, EN↔DE). Make them by taking good human/MT translations and **injecting labeled errors** (omitted clause, changed amount, wrong party, terminology error, hallucinated addition, partial delivery, injection attack).
- Also include real disputed cases once pilots run.
- Each item has: spec, deliverable, ground-truth verdict, and per-criterion labels.

---

## 7. Build plan: part by part (first → last)

Each part ships behind tests and is demoable on its own.

| # | Part | Weeks | Done when |
|---|---|---|---|
| **0** | **Validation + legal + golden set** | 1–2 | 15+ interviews (agent builders, marketplaces). 3 design-partner LOIs. Lawyer memo on the card/stablecoin flows. Translation golden set v1 (300 items). Name/brand cleared of "escrow." |
| **1** | **Foundation**: monorepo, CI, DB, auth/API keys, agreement state machine, **ledger** (hash chain + verify tool) | 3 | State machine 100% unit-covered. The ledger tamper test fails on any edited row. |
| **2** | **Spec Engine**: request → draft criteria → edit → approve → spec hash. AP2 mandate import. | 3–4 | 50 sample requests produce checkable criteria (human-rated ≥90% "testable"). |
| **3** | **Verification Engine v1 (translation)**: deterministic + QE service + judge ensemble + decision policy + eval harness | 4–6 | **Hits the §6 targets on the golden set**. Eval runs in CI. |
| **4** | **Card rail**: Stripe Connect Express onboarding, auth hold, extended auth, capture/cancel, partial capture, Connect delayed transfers for jobs over 7/30 days, webhooks, idempotency | 7–8 | Full flow passes in Stripe test mode, including the auth-expiry path and webhook replays. |
| **5** | **Developer surface**: REST API, webhooks, TS SDK, **MCP server**, API docs, sandbox mode | 8–9 | An outside developer finishes the quickstart in under 15 minutes. A Claude agent completes "hire translator, pay only if accurate" through MCP. |
| **6** | **Dashboard + human review**: buyer/seller views, verdict report (criteria, evidence, ledger proof), ops review queue, disputes + appeal window, reviewer payouts | 10–11 | Dispute resolved end-to-end. The verdict report is shareable. |
| **7** | **Stablecoin rail**: ERC-8183-compatible job contract + evaluator adapter on Base Sepolia; x402/MPP funding; USDC payouts | 12–13 | Foundry invariant tests (funds conserved; only the evaluator can complete/reject; refund after timeout). External audit booked before mainnet. |
| **8** | **Verifier #2 + #3**: code (sandboxed tests) and structured data/research | 14–15 | Each has its own golden set and meets targets |
| **9** | **Billing + hardening + launch**: Stripe Billing for fees, rate limits, security review, adversarial red-team week, status page, pricing page, design-partner go-live | 16–17 | Live real-money jobs with 3 partners. SOC 2 readiness started. |
| **10** | **Scale (months 5–12)**: licensed escrow partner for >$5K B2B, evaluator-for-hire listing in Virtuals/ERC-8183 ecosystems, on-chain ledger anchoring, more verticals, public accuracy report | — | $50K+ MRR or 10 platform partners |

---

## 8. Daily execution and testing

### Daily loop
| Block | Activity | Output |
|---|---|---|
| 15 min | Pick ONE slice from the current Part. Write acceptance criteria in `docs/daily/YYYY-MM-DD.md`. | Definition of done |
| 30 min | Write failing tests first (unit / eval cases / payment scenario) | Red |
| ~4 h | Build with Claude Code in small commits | Green |
| 45 min | **Reality check:** run the full eval harness + adversarial suite + payment scenarios. Compare metrics to yesterday. | Metrics diff |
| 30 min | Merge → deploy to staging → smoke test (one full agreement flow in Stripe test mode) | Shipped |
| 15 min | Log: shipped / broke / metric changes / tomorrow's slice | Daily note |

**Hard rules:**
1. No merge if eval metrics regress past the targets.
2. Every bug or false verdict becomes a permanent test case.
3. Money code paths need idempotency keys and a replay test.
4. No real money until the lawyer signs off.

### Test layers
1. **Unit (Vitest):** state machine, decision policy, deterministic checkers, ledger hashing
2. **Verifier evaluation harness:** runs the golden set and reports false release, false refund, critical recall, escalation rate, cost/job and latency. Runs in CI on every change to prompts, models or thresholds.
3. **Adversarial suite:** prompt-injection deliverables, partial work, subtle number changes, plausible-but-wrong translations, padding attacks, criteria-gaming
4. **Payment scenarios (Stripe test mode + test clocks):** happy path, auth expiry, partial capture, Connect delayed transfer, webhook duplicates/out-of-order, dispute/chargeback simulation, capture double-fire prevention
5. **Smart contracts (Foundry):** unit + fuzz + invariant tests (sum of balances is conserved; only the evaluator decides; timeout refunds always possible)
6. **E2E (Playwright + an MCP test client):** a real agent calls MCP → spec → fund → deliver → verdict → release
7. **Shadow mode in pilots:** for the first 2 weeks, every automatic verdict is also reviewed by a human. Disagreements feed the golden set.

### Weekly (Friday)
- Metrics review: accuracy targets, cost/job, latency, jobs, GMV, revenue
- Demo to at least one design partner
- Re-plan next week

---

## 9. Day-by-day: first 4 weeks

**Week 1: Validate + legal + data**
- **Day 1:** List 60 targets (agent marketplaces, translation/content platforms, agent builders on MCP/x402, Virtuals ACP builders). Write the interview script. Book a fintech lawyer.
- **Day 2:** 15 outreach messages + 3 interviews. Start the golden set: collect 100 source contract/ToS segments, public-domain or self-written.
- **Day 3:** Interviews. Write the error-injection script (programmatically mutate numbers, drop clauses, swap parties, add hallucinations, inject prompts).
- **Day 4:** Interviews. Generate the 300-item golden set. Hand-label a 60-item subset to check the injections.
- **Day 5:** Lawyer call: confirm the card auth-hold flow, the Connect flow, non-custodial on-chain evaluator, and naming. Synthesize interviews. **Friday review.**

**Week 2: Prove the verifier can work (spike) + secure partners**
- **Day 6:** Throwaway script: LLM judge only on the golden set → baseline metrics
- **Day 7:** Add deterministic number/date/entity diff + clause alignment → re-measure
- **Day 8:** Add xCOMET-QE/MetricX-QE scoring → re-measure. Pick thresholds.
- **Day 9:** Adversarial cases → re-measure. Write up the "verifier accuracy v0" report.
- **Day 10:** Show the report to prospects. Ask for pilot LOIs. **GO/NO-GO GATE.**

**Week 3: Foundation + Spec Engine**
- **Day 11:** Monorepo, CI (lint, typecheck, test, eval job), Postgres, migrations, env/secrets
- **Day 12:** API keys/auth, accounts, agreement model, state machine + tests
- **Day 13:** Append-only hash-chained ledger + `verify-ledger` CLI + tamper tests
- **Day 14:** Spec Engine: request → draft criteria (Haiku/Sonnet) → JSON schema-validated spec
- **Day 15:** Spec approval + spec hash lock + AP2 mandate parsing stub. **Friday review.**

**Week 4: Verification Engine v1 (productionize the spike)**
- **Day 16:** Verifier plugin interface + deterministic checkers module
- **Day 17:** QE microservice (Python, Modal) + client + caching
- **Day 18:** Judge ensemble with evidence quoting + injection-hardened prompt wrapper
- **Day 19:** Decision policy + confidence + critical-error override + escalation
- **Day 20:** Eval harness wired into CI with target gates. Compare with the Week 2 spike. **Friday review.**

**Weeks 5–17:** same daily loop, following Parts 3→9 in §7. From Week 7 on, spend at least 1 day a week on design partners: integration support, shadow-mode reviews.

---

## 10. Immediate next actions
1. Confirm the product name (avoid "escrow"). Working name: **Proof Desk**.
2. Send me the list of "networks #1, #7, #8" so the integrations target them.
3. Book a fintech/payments lawyer for Week 1.
4. Create a Stripe account (test mode) and an Anthropic API key.
5. Decide the first vertical. The recommendation is **contract/document translation**: it's your example, it has measurable quality metrics and clear critical errors, and job values run $50–$1,000. Code (with tests) is a close second because it's the most deterministic to verify.

---

## Sources
- Nava seed: [Fortune](https://fortune.com/2026/04/14/nava-seed-funding-ai-financial-agents/)
- Internet Court: [CoinDesk](https://www.coindesk.com/business/2026/07/10/okx-metamask-matter-labs-back-dispute-resolution-court-for-ai-agents), [The Sociable](https://sociable.co/business/genlayer-26-companies-launch-internet-court-for-ai-agent-disputes/)
- ERC-8183: [Ethereum ERCs](https://ercs.ethereum.org/ERCS/erc-8183)
- Virtuals evaluator problem: [Forkast](https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/)
- Protocol comparison: [Fireblocks](https://www.fireblocks.com/blog/agentic-payment-protocols-compared), [Crossmint](https://www.crossmint.com/learn/agentic-payments-protocols-compared)
- Stripe MPP: [Techstrong](https://techstrong.ai/features/stripes-machine-payments-protocol-gives-ai-agents-a-way-to-spend-money-without-human-help/)
- x402 volume: [DEV](https://dev.to/t49qnsx7qtkpanks/x402-hit-165-million-transactions-heres-what-it-still-cant-do-4f4d), [Chainalysis](https://www.chainalysis.com/blog/x402-agentic-payments-adoption/)
- Stripe holds: [capture later](https://docs.stripe.com/payments/capture-later), [manual payouts](https://docs.stripe.com/connect/manual-payouts), [separate charges & transfers](https://docs.stripe.com/connect/marketplace/tasks/accept-payment/separate-charges-and-transfers), [stablecoin payouts](https://docs.stripe.com/connect/stablecoin-payouts)
- CA escrow law: [DFPI enforcement example](https://dbo.ca.gov/wp-content/uploads/sites/337/2020/09/D-R-DealTrustMaker.com_.pdf)
- Agent-of-payee exemption: [Cooley](https://www.cooley.com/news/insight/2021/2021-03-29-who-is-an-agent-of-a-payee-in-california)
- Escrow.com API: [api.escrow.com](https://api.escrow.com/), [fee change](https://domaininvesting.com/escrow-com-escrow-fee/)
- LLM-judge reliability: [arXiv 2603.22214](https://arxiv.org/abs/2603.22214), [One Token to Fool LLM-as-a-Judge](https://arxiv.org/pdf/2507.08794)
- Translation QE: [xCOMET](https://arxiv.org/pdf/2310.10482)
