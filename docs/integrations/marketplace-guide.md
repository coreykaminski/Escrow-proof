# Add "pay only when it's done right" to your marketplace

This guide follows `examples/marketplace/server.ts` ("TaskHub"): a working, single-file marketplace that integrates Proof Desk with the public SDK. Run it, then copy the parts you need. It takes about an afternoon.

## 0. Run it locally (5 minutes)
```bash
npm install
npm run cli -- create-account --name "TaskHub"          # prints a pd_test_ key
npm run cli -- create-account --name "Ops" --ops        # prints an ops key (to run the scheduler)
npm run dev                                             # Proof Desk API on :8787
PROOFDESK_API_KEY=pd_test_… npm run example:marketplace # TaskHub on :3000
```
Open http://localhost:3000, post the sample job, approve it, deliver the sample code, and watch the verdict appear. Run `npm run worker` too (or `POST /v1/ops/run-due` with the ops key) to see webhooks arrive in TaskHub's log.

## 1. Turn the buyer's request into checkable criteria
Proof Desk decides against criteria agreed **before** money moves, so the most important step is picking good ones.
- **Templates (no AI):**
  ```ts
  pd.agreements.createFromTemplate({ template: "code.acceptance-tests", params: { task }, buyer_ref, seller_ref, amount, delivery_due_at })
  ```
  `GET /v1/spec-templates` lists them all with their parameters: code with tests, datasets, cited research, translation.
- **Your own criteria:** `pd.agreements.create({ spec })`.
- **Drafted by AI from plain language:** `pd.agreements.createFromRequest(...)` (needs the server's Anthropic key).
- **Attach what the work is judged against** with `replaceInputs`: the buyer's tests, a JSON schema, the source text. Do it before approval, because the inputs are part of what the buyer approves.

## 2. Get the buyer's consent to the exact checks
Show the buyer `agreement.spec.criteria`, then call `pd.agreements.approveSpec(id, agreement.spec_hash)`. The hash pins exactly what they saw: if the spec changes, the old hash is refused.

## 3. Hold the payment
- **Sandbox:** `pd.agreements.fund(id, { rail: "test", hold_ref })`.
- **Card:**
  1. Onboard the seller once with `pd.sellers.startOnboarding(sellerRef, { email, country })`. Stripe hosts the form.
  2. Place the hold:
     - from your own checkout, with `pd.agreements.createCardHold(id, { payment_method })`;
     - from an AI agent, with `{ shared_payment_token }`;
     - or with no checkout of your own: `pd.agreements.createPaymentLink(id)` gives a hosted payment page.
- **USDC:** `pd.sellers.setWallet(sellerRef, address)`, then `createOnchainJob` or `createPaymentLink(id, { rail: "onchain" })`.

The money stays with Stripe or in a public contract; Proof Desk never holds it. Live jobs over $5,000 need a licensed escrow partner and are refused for now.

## 4. Take the delivery
Send the seller's files with `pd.agreements.deliver(id, [{ name, media_type, content }])`. Up to 20 files, 1 MB each. Proof Desk hashes every file.

## 5. Proof Desk checks it
In production Proof Desk verifies every delivery itself. Each check counts toward your monthly verification fees. The result is one of:
- **Release:** every check passed.
- **Refund:** a critical check failed.
- **Partial:** part of the payment is released.
- **Escalated:** a human reviewer decides.

In the sandbox you trigger it with `pd.testHelpers.verify(id)`, and `pd.testHelpers.settle(id)` skips the appeal window.

## 6. Listen for events
- **Register once:** `pd.webhookEndpoints.create({ url })` returns a `secret`. Store it.
- **On each POST:**
  ```ts
  const event = await verifyWebhook(rawBody, req.headers["proofdesk-signature"], secret);
  ```
  - Pass the **raw** body, exactly as received.
  - Respond `2xx`; anything else is retried with backoff.
  - Events arrive in ledger order with a stable `id`, so de-duplicate by it.
- **Events to handle:**
  - `agreement.fund`
  - `agreement.deliver`
  - `agreement.decide` (outcome in `data.outcome`)
  - `agreement.escalate`
  - `agreement.open_dispute` / `agreement.resolve_dispute`
  - `agreement.settle`: money moved
  - `agreement.content_deleted`: the retention period passed

## 7. Show the verdict
`pd.agreements.createReportLink(id)` returns `embed.html`. Paste it into your order page for a self-sizing verdict card (see [embed.md](embed.md)), or link to `url` for the full report with the downloadable proof.

## 8. Disputes
Either side may dispute an outcome that went against them, within the appeal window: `pd.agreements.openDispute(id, { opened_by: "buyer" | "seller", reason })`. A Proof Desk reviewer decides, and that decision is final.

## Going live
- **Keys:** switch to a `pd_live_` key. Card holds then use your live Stripe connection.
- **Pilot mode:** for the first two weeks every automatic decision waits for a human check (shadow mode, switched on by Proof Desk).
- **No payment needed?** If you only need the checking, use the Verify API instead: `pd.verifications.create({ template | spec, inputs, deliverable })`.
