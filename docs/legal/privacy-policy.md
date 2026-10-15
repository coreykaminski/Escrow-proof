# Proof Desk Privacy Policy

> **DRAFT for counsel review. Not legal advice. Not for publication.** `[BRACKETS]` mark decisions and facts to confirm.

`[ENTITY NAME]` ("Proof Desk") provides conditional payments and work verification to businesses ("Platforms") through an API. This policy explains what personal information we handle, why, and your choices. Last updated: `[DATE]`.

## Two roles
- **On behalf of Platforms (processor or service provider).** When a buyer and seller transact through a Platform, the Platform decides what's collected. We process it on the Platform's instructions under our Data Processing Agreement. Questions about that data go first to the Platform.
- **For our own purposes (controller).** This covers Platform staff accounts, billing contacts, sign-ups for our sandbox, website visitors, security logs, and the records we must keep.

## What we process
| Category | Examples | Source |
|---|---|---|
| Identifiers chosen by the Platform | buyer and seller references (pseudonymous IDs), seller payout account IDs | Platform |
| Work content | requests, acceptance criteria, source files, deliverables. These may contain personal information if the work does. | Platform, buyers, sellers |
| Payment information | handled by Stripe: we receive payment status and limited card details (brand, last 4); we never receive full card numbers. Stablecoin wallet addresses. | Stripe, buyers, sellers |
| Decisions and reasons | verification results, reviewer reasons, dispute reasons | Our checks and reviewers, the parties |
| Contact details | billing email, sandbox sign-up name and email | Platforms, developers |
| Technical data | IP addresses (for security and rate limiting), request logs with request IDs | Your device |

We don't knowingly process children's information, and we don't sell personal information.

## Why (and our legal bases, where applicable)
- **To provide the Service:** holding and settling payments; checking work; human review; appeals. This is to perform our contracts with Platforms, and is done on their instructions.
- **To keep tamper-evident records** of decisions and money movement: legitimate interests, plus the legal and accounting obligations `[COUNSEL]`.
- **Security, fraud prevention and abuse prevention:** legitimate interests.
- **Billing:** contract.
- **Improving our checks**, using cases where a human reviewer disagreed with an automatic decision: only for Platforms that opt in.

## Automated decisions
Some decisions about whether a payment is released are made automatically, against criteria the buyer approved in advance. Uncertain cases go to a human. The party a decision goes against can appeal within the appeal window, and a human reviews the appeal. `[COUNSEL: GDPR Art. 22 / Quebec Law 25 s.12.1 disclosures, brief Q8.]`

## Who we share with (subprocessors)
- **Stripe:** payments.
- **Anthropic:** AI analysis of content for some checks. Under our API terms, content isn't used to train their models `[COUNSEL: confirm current terms]`.
- **Fly.io:** hosting.
- **Neon:** database.
- **Amazon Web Services:** key management; no personal content.
- **Base blockchain:** public record of summary hashes and, for stablecoin payments, wallet addresses and amounts, which are public by nature.

The current list and locations are in our DPA. We may disclose information if required by law, or to protect rights and safety.

## International transfers
We're based in `[COUNTRY]`. Our providers may process data in the United States and elsewhere, with appropriate safeguards `[COUNSEL]`.

## How long we keep it
- **Delivered files, inputs and quoted evidence:** deleted 90 days after the agreement is final (or as the Platform configures), or sooner when the Platform asks once the agreement is final.
- **Records:** decision records, hashes and our tamper-evident ledger are kept permanently. They contain pseudonymous references, not documents.
- **Public verdict records:** anonymous.
- **Billing records:** kept as required by law `[N years]`.
- **Security logs:** kept for `[90]` days.

## Security
Measures include:
- encryption in transit;
- hashed API keys and session tokens;
- per-account isolation;
- an isolated environment for running delivered code;
- access limited to staff and reviewers who need it;
- regular security testing.

## Your rights
Depending on where you live, you may have rights to access, correct, delete or port your information, or to object to or restrict its use. If your information came through a Platform, contact the Platform; we'll help them respond. Otherwise contact `[privacy@…]`. You may also complain to your data protection authority `[e.g. Office of the Privacy Commissioner of Canada]`.

## Changes and contact
We'll post changes here and notify Platforms of material changes. Contact: `[privacy@…]`, `[ADDRESS]`.
