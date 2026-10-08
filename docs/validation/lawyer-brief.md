# Brief for fintech counsel: Proof Desk

**Ask:** a short written opinion (memo) on whether Proof Desk's payment flows need a licence or registration as designed, and what to change if so, before any real money moves. Budget in the plan: ~$3–8K.

## What Proof Desk does

Platforms (marketplaces, AI-agent builders) use Proof Desk when one party pays another for a deliverable, such as a translation. Before payment, buyer and seller approve written acceptance criteria. The buyer's payment is held. After delivery, Proof Desk checks the deliverable against the criteria (automated checks; a human reviewer for uncertain cases and disputes) and the payment is released to the seller or refunded to the buyer. Either side can dispute within an appeal window (default 72 hours); a human makes the final call.

Revenue: a fee of about 2% of the released amount, verification fees, and a dispute fee paid by the losing side.

## How the money moves (as built, in Stripe test mode today)

- **Entity and accounts:** Proof Desk's Stripe account is in **Canada** and settles in **CAD**. Prices are in **USD** (decided), so Stripe converts each charge to CAD. Buyers and sellers may be anywhere; the first test seller is in the US.
- **Card rail (Stripe Connect, "separate charges and transfers"):**
  1. The buyer's card is **authorized, not charged** (a PaymentIntent with manual capture) on Proof Desk's Stripe account. Authorizations last about 7 days. Extended authorization isn't available on this account.
  2. **Release:** Proof Desk captures the authorization and transfers the seller's share (minus the fee) to the seller's Stripe connected account (Accounts v2, Express dashboard). Proof Desk is configured as responsible for Stripe fees and for losses (refunds, chargebacks).
  3. **Refund:** the authorization is cancelled; the buyer is never charged.
  4. **Partial:** only the seller's share is captured.
  5. **Long jobs:** if a decision isn't final before the authorization would lapse, Proof Desk **captures early** and the funds sit in Proof Desk's Stripe balance until the decision is final (then transfer to the seller, or refund the buyer).
- **Stablecoin rail (planned, Part 7):** a smart contract holds USDC. Proof Desk is only the **evaluator** that signs "complete" or "reject"; it never controls the funds.
- **Large B2B jobs (planned):** route through a licensed escrow partner (e.g., Escrow.com).
- Proof Desk never holds funds in its own bank account; card funds are in Stripe's custody.

## Questions

### Licensing and registration
1. **Canada, Retail Payment Activities Act:** does holding, capturing and transferring funds this way make Proof Desk a payment service provider that must register with the Bank of Canada? Does the answer change for the "capture early, hold in the Stripe balance" path?
2. **Canada, FINTRAC:** is Proof Desk a money services business (e.g., "transferring funds") requiring registration and AML/KYC obligations? Can we rely on Stripe's KYC of connected accounts?
3. **US, money transmission:** with US buyers and sellers, does the flow trigger state money-transmitter licensing or FinCEN MSB registration? Do the "agent of the payee" or "payment processor" exemptions apply, given that Proof Desk, not the seller, decides whether funds are released?
4. **California escrow law:** does conditional release make Proof Desk an "escrow agent" (Cal. Fin. Code §17000 et seq.)? Which words can we use: "conditional payment", "payment hold", "pay on proof"? Is "escrow" off-limits in names, domains and marketing?
5. **Does the answer change** between: authorization-only (released or cancelled within ~7 days), captured funds held up to ~30 days, and the on-chain evaluator-only model? Which design should we prefer?

### Liability and terms
6. Who is the **merchant of record** for the buyer's card statement and consumer-protection purposes: Proof Desk or the seller? What must the descriptor and receipts say?
7. **Chargebacks:** a buyer can dispute with their card issuer even after our decision. How should the terms allocate that risk between Proof Desk, the platform, and the seller?
8. **Automated decisions:** what disclosures and appeal rights are needed when software decides who gets paid (e.g., Quebec Law 25, GDPR Art. 22 for EU users, US state AI or consumer laws)? Is the 72-hour human appeal sufficient?
9. **Our role in disputes:** is acting as decision-maker an arbitration or adjudication service with its own rules? Should the terms make the decision binding between the parties, or advisory with refund rights?
10. **Cross-border:** a Canadian platform charging US buyers in USD and paying US sellers. Any tax (GST/HST on our fee), reporting (1099-K for US sellers?), or sanctions-screening obligations?

### Data
11. Deliverables and source documents (e.g., contracts to translate) are stored and sent to an AI provider (Anthropic) for checking. What consents, data-processing terms and retention limits do we need (PIPEDA, Quebec Law 25, US state privacy laws)?

## What we'd like back
- Which flows are fine as-is, which need changes, and which need a licence or a licensed partner.
- Approved wording for product and marketing (no "escrow" unless cleared).
- A list of what the platform terms and the buyer/seller terms must contain.

**Contact:** Corey Kaminski · coreykaminski00@outlook.com · technical details on request (architecture, Stripe configuration, ledger design).
