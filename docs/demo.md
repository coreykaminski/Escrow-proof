# Demo guide

`npm run demo` runs everything on your laptop, with no accounts and no internet services. It prints the URLs and two keys (platform and reviewer). Ctrl+C stops it.

## A 10-minute walkthrough
1. **The problem (30 s).** "Agents and freelancers deliver work; buyers pay up front and hope. We make payment depend on the work passing checks both sides agreed to."
2. **A customer's site** (`localhost:3001`). An order page with our verdict widget: one order *passed*, one *failed*. "This is all a marketplace adds to its page: two lines of HTML."
3. **The failed one, full report.** Click "Full report and proof".
   - The buyer's hidden test caught a solution that only passed the public tests, so the buyer was refunded.
   - Show the checks, the reason, and that no documents are exposed.
4. **The proof.** Click "download the proof" on the report.
   - "Anyone can check this offline against a record we post on a public blockchain daily. They don't have to trust us."
   - Show `/verdicts.json`: anonymous public verdicts, with no names or amounts.
5. **TaskHub** (`localhost:3000`). Live, in front of them:
   1. Post a job (the buyer's tests are prefilled), approve the checks, pay.
   2. Deliver the code. The verdict appears in seconds.
   3. Optionally break the code first, to show a refund.
6. **Reviewer dashboard** (sign in with the reviewer key).
   - The review queue holds a research brief the checker couldn't decide, so a human does. That's the safety net.
   - "Shadow review" is pilot mode: every automatic decision waits for a human until we've earned the partner's trust.
7. **Platform dashboard** (sign in with the platform key): agreements, usage and billing.
8. **For their developers:** `/signup` (a sandbox key in a minute), `/docs`, the SDKs, and `/.well-known/agent-card.json` for AI agents.
9. **Trust:** `/accuracy` shows the published accuracy on labelled test sets, and live numbers once there's traffic.

## Don't say
- **"Escrow."** Say "conditional payments" or "pay on proof".
- **That it's live or has customers.** It's a working product running locally.
- **Translation accuracy numbers.** They aren't measured yet.
