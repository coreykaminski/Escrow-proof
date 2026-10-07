# Proof Desk quickstart

Get a payment that is only released when the work passes its checks, end to end in the sandbox, in about 15 minutes.

**You'll need:** Node 22+ and git. No Stripe or Anthropic account is needed for the sandbox.

## 1. Run the API (3 min)

```bash
git clone https://github.com/coreykaminski/Escrow-proof.git proof-desk && cd proof-desk
npm install
npm run cli -- create-account --name "My Platform"     # prints a pd_test_… key; copy it
npm run dev                                             # API on http://localhost:8787
```

The API reference is at <http://localhost:8787/docs>.

## 2. Run one agreement through its whole life (5 min)

In a second terminal:

```bash
PROOFDESK_API_KEY=pd_test_… npx tsx examples/quickstart.ts
```

You should see:

```
1. Created agr_… (draft)
2. Spec approved
3. Funded
4. Delivered
5. Decided: release; appeal window ends …
6. settled (sandbox:agr_…)
7. Ledger: agreement.created → agreement.approve_spec → agreement.fund → agreement.deliver → agreement.start_verification → agreement.decide → agreement.settle
```

[examples/quickstart.ts](../examples/quickstart.ts) is short. Each step maps to one SDK call:

| Step | Call | What happens |
|---|---|---|
| Create | `pd.agreements.create({ buyer_ref, seller_ref, spec })` | A draft with the acceptance criteria the work will be checked against. |
| Approve | `pd.agreements.approveSpec(id, spec_hash)` | The buyer approves *exactly* the spec they saw, by its hash. |
| Fund | `pd.agreements.fund(id, { rail: "test", … })` | The money is held. Live: `createCardHold` places a card authorization. |
| Deliver | `pd.agreements.deliver(id, artifacts)` | The seller's files are hashed and recorded. |
| Decide | `pd.testHelpers.decide(id, outcome)` | In production Proof Desk verifies and decides. In the sandbox you simulate it. |
| Settle | `pd.testHelpers.settle(id)` | After the appeal window the money moves. The sandbox skips the wait. |

Every write accepts an `Idempotency-Key` (the SDK adds one automatically), so retries never act twice.

## 3. Get events by webhook (3 min)

```ts
const endpoint = await pd.webhookEndpoints.create({ url: "https://your.app/proofdesk-webhooks" });
// Save endpoint.secret now; it's only shown once.
```

Proof Desk sends every ledger event for your agreements (e.g. `agreement.decide`, `hold.settled`) in order, signed with `Proofdesk-Signature`. Verify it before trusting it:

```ts
import { verifyWebhook } from "@proofdesk/sdk";

// Express example: verify against the raw, unparsed body.
app.post("/proofdesk-webhooks", express.text({ type: "application/json" }), async (req, res) => {
  const event = await verifyWebhook(req.body, req.get("Proofdesk-Signature") ?? "", process.env.PROOFDESK_WEBHOOK_SECRET!);
  // De-duplicate on event.id: delivery is at-least-once.
  res.sendStatus(200);
});
```

Locally, events go out when the scheduler ticks: `npm run cli -- run-due` (run it from cron in production). For `localhost` URLs, plain `http` is allowed.

## 4. Let an AI agent buy through Proof Desk (MCP) (3 min)

Add the MCP server to Claude Code or Claude Desktop:

```json
{
  "mcpServers": {
    "proof-desk": {
      "command": "npx",
      "args": ["tsx", "/path/to/proof-desk/apps/mcp/src/main.ts"],
      "env": { "PROOFDESK_API_KEY": "pd_test_…", "PROOFDESK_BASE_URL": "http://localhost:8787" }
    }
  }
}
```

Then ask the agent: *"Hire translator_agent_7 to translate this contract into Spanish for $180, due Friday. Only pay if it's accurate."* The agent calls `create_protected_purchase`, shows you the drafted criteria, and then calls `approve_purchase_terms` and `fund_purchase`. With a test key it can finish with `sandbox_run_verification` and `sandbox_settle`.

The criteria drafting in `create_protected_purchase` and `sandbox_run_verification` call Claude, so they need `ANTHROPIC_API_KEY` in the API server's `.env`. Without it, the agent can still use `sandbox_simulate_decision`.

## 5. Going further

- **Drafted criteria:** with `ANTHROPIC_API_KEY` set, use `pd.agreements.createFromRequest({ request, amount, delivery_due_at, … })`. Proof Desk writes checkable acceptance criteria and lists open questions for the buyer.
- **Translation verification:** attach the source with `pd.agreements.replaceInputs(id, [{ name, media_type: "text/plain", content }])` before approval. After delivery, `pd.testHelpers.verify(id)` runs the real verifier.
- **Real cards (Stripe test mode):** set `STRIPE_SECRET_KEY=sk_test_…`, onboard the seller with `pd.sellers.startOnboarding(seller_ref, { email, country: "us" })` (they finish on Stripe's hosted page), then call `pd.agreements.createCardHold(id, { payment_method: "pm_card_visa" })`.
