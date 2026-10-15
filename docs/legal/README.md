# Legal drafts: for counsel to review

**Status: DRAFTS written by the founder and the engineering assistant, not by a lawyer, and not legal advice.**

They exist so counsel can review and correct rather than draft from scratch. Every `[BRACKETED]` item is a decision or a fact still to confirm. Nothing here should be published or signed until counsel has reviewed it, together with the licensing questions in [../validation/lawyer-brief.md](../validation/lawyer-brief.md). The answers to those questions may change these documents substantially.

| Document | Who agrees to it | Purpose |
|---|---|---|
| [platform-agreement.md](platform-agreement.md) | Each platform (marketplace, agent builder) that uses the API | Service terms: what Proof Desk does and doesn't do, fees, verification limits, disputes, liability, data |
| [privacy-policy.md](privacy-policy.md) | Published on the website | What personal information we process, why, with whom, for how long |
| [dpa.md](dpa.md) | Attached to the platform agreement | Data processing terms (Proof Desk as the platform's processor), including subprocessors |

## Facts these drafts rely on (as built, October 2026)
- **Proof Desk is infrastructure.** Platforms integrate it by API and present it to their buyers and sellers. We have no direct consumer relationship, except through hosted payment and report pages.
- **Card rail:**
  - Stripe Connect, separate charges and transfers, using Proof Desk's Canadian Stripe account. Prices are in USD.
  - Authorization holds are captured on release and cancelled on refund.
  - **Long jobs may be captured early and sit in Proof Desk's Stripe balance until the decision is final.** See brief, Q1 and Q5.
- **Stablecoin rail:** a public smart contract holds USDC. Proof Desk is only the *evaluator* address and can direct funds only to the job's own seller or buyer. It isn't on mainnet; an audit comes first.
- **Live jobs above US$5,000** are refused until a licensed escrow partner is integrated.
- **Verification:**
  - Automated checks first: deterministic checks, a sandboxed run of the buyer's tests for code, and AI models (Anthropic) for some checks.
  - A human reviewer for uncertain cases, for appeals (one appeal window per decision, default 72 hours), and, in pilot "shadow mode", for every automatic decision.
- **Records:**
  - An append-only, hash-chained ledger. A summary hash is posted daily on the Base blockchain.
  - An anonymous public record of each final live verdict: a salted identifier, the outcome, who decided, and the day.
- **Retention:**
  - Delivered files, inputs and quoted evidence are deleted 90 days after an agreement is final (configurable per platform; deletion on request once final).
  - Hashes and ledger entries are kept permanently.

## Decisions needed (beyond the brief)
1. **Contracting entity, governing law and venue:** `[ENTITY]`, `[PROVINCE / STATE]`.
2. **Liability cap:** currently drafted as fees paid in the prior 12 months.
3. **Customer content for testing:** may disagreement cases be used to improve the checker? Drafted as opt-in per platform.
4. **The decision's effect between buyer and seller** (brief, Q9): binding, or advisory with a refund remedy.
5. **Retention default (90 days)** and whether platforms may shorten or extend it.
6. **Whether buyers and sellers need their own short terms** (shown on the hosted payment page), or the platform's terms suffice.
