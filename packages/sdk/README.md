# @proofdesk/sdk

The TypeScript client for [Proof Desk](https://github.com/coreykaminski/Escrow-proof): payments that release only when the work passes checks both sides agreed to, plus a Verify API for checking work with no payment held.

- **No dependencies.** Runs on Node 18+, browsers, Deno, Bun and edge runtimes.
- **Safe retries:** every write carries an idempotency key, reused when the call is retried.

```bash
npm install @proofdesk/sdk
```

```ts
import { ProofDesk, verifyWebhook } from "@proofdesk/sdk";

const pd = new ProofDesk({ apiKey: process.env.PROOFDESK_API_KEY!, baseUrl: "https://<your proof desk host>" });

// Check work against acceptance criteria, no payment held:
const job = await pd.verifications.create({
  template: { id: "data.dataset", params: { task: "EU capitals", min_records: 27, unique_key: "city" } },
  inputs: [{ name: "schema.json", media_type: "application/schema+json", content: schemaJson }],
  deliverable: [{ name: "capitals.csv", media_type: "text/csv", content: csv }],
});
job.outcome; // { kind: "release" } passed, { kind: "refund" } failed; status "escalated" = a human decides

// Or a full protected purchase:
const agreement = await pd.agreements.createFromTemplate({
  template: "code.acceptance-tests",
  params: { task: "Write slugify(s)." },
  buyer_ref: "buyer_1",
  seller_ref: "agent_7",
  amount: { value: 4_000, currency: "usd" },
  delivery_due_at: "2026-11-01T00:00:00Z",
});

// Webhooks: pass the raw body exactly as received.
const event = await verifyWebhook(rawBody, req.headers["proofdesk-signature"], endpointSecret);
```

Get a sandbox key at `<host>/signup`. Full guides:
- [Marketplace integration guide](https://github.com/coreykaminski/Escrow-proof/blob/main/docs/integrations/marketplace-guide.md)
- [Embedding the verdict](https://github.com/coreykaminski/Escrow-proof/blob/main/docs/integrations/embed.md)
- API reference: `<host>/docs`
