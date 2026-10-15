# Proof Desk Platform Agreement

> **DRAFT for counsel review. Not legal advice. Not for publication or signature.** `[BRACKETS]` mark decisions and facts to confirm.

This Platform Agreement (the "Agreement") is between `[ENTITY NAME]` ("Proof Desk", "we") and the business accepting it (the "Platform", "you"). It governs your use of the Proof Desk API, SDKs, dashboard, hosted pages and related services (the "Service"). Effective date: `[DATE]`.

## 1. What the Service is
1.1 **Conditional payments.** The Service lets you create agreements between a buyer and a seller in which:
- (a) acceptance criteria are approved before payment;
- (b) payment is held by a payment provider or a public smart contract;
- (c) the delivery is checked against the criteria;
- (d) the payment is released to the seller, refunded to the buyer, or split, according to the decision.

1.2 **Verification only.** You may also use the Service to check work against criteria without any payment (the "Verify API").

1.3 **No custody.** Proof Desk does not hold buyer or seller funds in its own bank accounts.
- **Card payments:** these are authorized, captured and paid out through Stripe, our payment processor, under Stripe's terms. `[COUNSEL: describe the early-capture path accurately once its status is settled; see brief Q1/Q5.]`
- **Stablecoin payments:** these are held by a public smart contract. Proof Desk can only instruct that contract to pay the job's own seller or refund the job's own buyer.
- Proof Desk is not a bank, an escrow agent, or a trustee. `[COUNSEL: confirm wording.]`

1.4 **Limits.** Live agreements above US$5,000 can't currently be funded through the Service.

## 2. Your account and keys
2.1 You're responsible for your API keys and for all activity under them. Keep them secret. Revoke or roll a key promptly if it may be exposed.

2.2 **Test and live.** Test keys use simulated money and are free. Live keys are issued after onboarding `[and the checks Proof Desk requires]`.

2.3 **Your users.** You present the Service to your buyers and sellers, and you're responsible for having terms with them that are consistent with this Agreement. Those terms must include:
- (a) consent to the acceptance-criteria process and to automated and human verification;
- (b) the appeal window and dispute process;
- (c) the data processing described in the Privacy Policy and DPA.

`[COUNSEL: or require a short Proof Desk notice on the hosted payment page.]`

## 3. Acceptance criteria and verification
3.1 **Criteria are binding inputs.** Decisions are made against the acceptance criteria that the buyer approved, identified by a cryptographic hash, and against the inputs attached before approval. A spec that changes after approval isn't the approved spec.

3.2 **How checks work.** Verification uses, as applicable:
- deterministic checks;
- running the buyer's tests in an isolated environment;
- automated analysis using AI models from third-party providers;
- human reviewers.

When automated checks are uncertain, a human decides.

3.3 **No guarantee of correctness.** Verification can be wrong. We publish measured accuracy, but we don't warrant that any decision is correct, or that work that passed is fit for any purpose beyond the approved criteria. Criteria that are vague or untestable are likely to be escalated to a human, or to fail.

3.4 **Appeals.** Within the appeal window stated in the agreement (default 72 hours after a decision), the party the decision went against may appeal once. A Proof Desk reviewer decides the appeal. That decision is final within the Service. `[COUNSEL: effect between the parties: binding vs advisory; relationship to card chargeback rights, brief Q7/Q9.]`

3.5 **Pilot review.** During a pilot, Proof Desk may hold automatic decisions until a human reviewer confirms or changes them ("shadow mode").

## 4. Payments and settlement
4.1 **After a decision.** Once a decision is final (the appeal window has closed, or the appeal is decided), the Service settles it:
- **card:** capture or cancel the authorization, and transfer the seller's share to their connected account;
- **stablecoin:** instruct the contract.

Sellers must complete the payment provider's onboarding to receive payouts.

4.2 **Chargebacks.** Card networks may let buyers dispute charges independently of our decisions. `[COUNSEL: allocation of chargeback losses between Proof Desk, the Platform and the seller; currently Proof Desk is configured as liable to Stripe.]`

4.3 **Deadlines and expiry.**
- If nothing is delivered by the agreed deadline, the buyer is refunded.
- Stablecoin jobs not settled by their on-chain expiry become refundable to the buyer by anyone, by design.

## 5. Fees
5.1 **The fees** are those on our pricing page at the time an agreement is created, or as agreed in an order form:
- a conditional payment fee, a percentage of the released amount, retained at settlement;
- verification fees per check;
- a dispute fee, charged in respect of the losing party.

5.2 **Billing.** Verification and dispute fees are invoiced monthly in US dollars and due within `[14]` days. Verify-only plans have a monthly minimum. Payment processor fees are passed through.

5.3 **Taxes.** Fees exclude taxes. `[COUNSEL: GST/HST and cross-border tax treatment, brief Q10.]`

## 6. Acceptable use
You must not use the Service:
- (a) for unlawful goods, services or content, or to evade sanctions;
- (b) to submit malware, or deliverables designed to attack the Service or its reviewers, except in a coordinated security test we've agreed to;
- (c) to interfere with or overload the Service;
- (d) to impersonate others;
- (e) to process special-category personal data except as agreed in writing.

We may suspend agreements or keys that we reasonably believe break these rules, and we'll tell you why unless we're prevented by law.

## 7. Data
7.1 **Your content.** Specs, inputs, deliveries and related content remain yours. You grant us the rights needed to provide the Service, including sending content to the subprocessors listed in the DPA (for example, AI model providers for automated checks).

7.2 **Records we keep.**
- Proof Desk keeps an append-only, tamper-evident record of each agreement's events, with cryptographic hashes and decision reasons, and publishes a summary hash of that record on a public blockchain.
- For final live decisions, it publishes an anonymous record: a salted identifier, the outcome, whether it was automatic or human, and the date. That record contains no names, amounts or content.
- These records are permanent and are not personal data in themselves. `[COUNSEL: confirm, particularly for wallet addresses on the stablecoin rail.]`

7.3 **Retention.** We delete delivered files, inputs and quoted evidence 90 days after an agreement is final (or as configured for your account), or sooner on request once final. Hashes and records remain.

7.4 **Improving verification (opt-in).** If you opt in, cases where a human reviewer disagreed with an automatic decision may be used to test and improve our checks. They're handled under the DPA and deleted on the same schedule. They're never used to train third-party models.

7.5 **Data processing.** Our processing of personal information on your behalf is governed by the DPA.

## 8. Availability and changes
We aim for high availability and publish status at `/status`, but we don't guarantee uninterrupted service. A verification that can't run because a dependency is down waits and is retried; it isn't decided against either party. We may change the Service and these terms on `[30]` days' notice for material changes.

## 9. Warranties and liability
9.1 The Service is provided "as is", except as expressly stated. `[COUNSEL: consumer-law carve-outs as applicable.]`

9.2 Neither party is liable for indirect or consequential losses. Each party's total liability under this Agreement is capped at the fees you paid in the 12 months before the claim. `[COUNSEL: carve-outs for confidentiality, data protection, indemnities, fraud.]`

9.3 You indemnify us against claims from your users arising from your terms with them, or from your breach of this Agreement.

## 10. Term and termination
Either party may end this Agreement on `[30]` days' notice. Agreements already funded run to settlement under these terms. On termination you can export your data through the API for `[30]` days, after which it's deleted under section 7.3.

## 11. General
Governing law: `[JURISDICTION]`. Venue: `[COURTS]`. Notices: `[EMAIL / ADDRESS]`. This Agreement, the pricing page, the DPA and any order form are the entire agreement.
