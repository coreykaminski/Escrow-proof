/**
 * The quickstart, end to end in the sandbox: create → approve → fund → deliver → decide → settle.
 *
 *   PROOFDESK_API_KEY=pd_test_… npx tsx examples/quickstart.ts
 */
import { ProofDesk } from "@proofdesk/sdk";

const pd = new ProofDesk({
  apiKey: process.env.PROOFDESK_API_KEY ?? "",
  baseUrl: process.env.PROOFDESK_BASE_URL ?? "http://localhost:8787",
});

// 1. The buyer's request and its acceptance criteria. (With an Anthropic key on the server,
//    pd.agreements.createFromRequest drafts the criteria for you.)
const agreement = await pd.agreements.create({
  buyer_ref: "user_123",
  seller_ref: "writer_agent_9",
  spec: {
    version: 1,
    title: "Product description for the Ember mug",
    request: "Write a 60-80 word product description for our ceramic Ember mug.",
    vertical: "general",
    criteria: [
      {
        id: "length",
        description: "Between 60 and 80 words",
        check: "deterministic",
        critical: true,
      },
      {
        id: "mentions-material",
        description: "Says the mug is ceramic",
        check: "deterministic",
        critical: true,
      },
    ],
    amount: { value: 2_500, currency: "usd" }, // $25.00, in cents
    delivery_due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  },
});
console.log(`1. Created ${agreement.id} (${agreement.status})`);

// 2. The buyer approves exactly the spec they saw.
await pd.agreements.approveSpec(agreement.id, agreement.spec_hash);
console.log("2. Spec approved");

// 3. Hold the money. The sandbox uses the test rail; live uses createCardHold.
await pd.agreements.fund(agreement.id, { rail: "test", hold_ref: "quickstart" });
console.log("3. Funded");

// 4. The seller delivers.
await pd.agreements.deliver(agreement.id, [
  {
    name: "description.txt",
    media_type: "text/plain",
    content: "Meet the Ember mug: hand-glazed ceramic that keeps your coffee warm…",
  },
]);
console.log("4. Delivered");

// 5. In production, Proof Desk verifies the delivery against the criteria and decides.
//    In the sandbox, simulate that decision:
const decided = await pd.testHelpers.decide(agreement.id, { kind: "release" });
console.log(
  `5. Decided: ${decided.outcome?.kind}; appeal window ends ${decided.appeal_window_ends_at}`,
);

// 6. After the appeal window the money moves. Sandbox: settle now.
const settled = await pd.testHelpers.settle(agreement.id);
console.log(`6. ${settled.status} (${settled.settlement_ref})`);

// 7. Every step is on the tamper-evident ledger.
const ledger = await pd.agreements.ledger(agreement.id);
console.log(`7. Ledger: ${ledger.data.map((e) => e.type).join(" → ")}`);
