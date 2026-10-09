import type { z } from "zod";
import { z as zod } from "zod";
import {
  BillingSettingsBody,
  PeriodBody,
  PlanBody,
  ReviewerOnboardingBody,
} from "./routes/billing.ts";
import { ReviewBody, ShadowModeBody } from "./routes/reviews.ts";
import {
  ApproveSpecBody,
  CancelBody,
  CardHoldBody,
  CreateAgreementBody,
  DecideBody,
  DeliveryBody,
  DisputeBody,
  FromMandateBody,
  FromRequestBody,
  FundBody,
  InputsBody,
  LinkBody,
  OnboardingBody,
  OnchainAuthorizationBody,
  OnchainConfirmBody,
  OnchainJobBody,
  PaymentLinkBody,
  ReplaceSpecBody,
  ResolveDisputeBody,
  SellerWalletBody,
  SettleBody,
} from "./routes/schemas.ts";
import { SimulateDecisionBody } from "./routes/test-helpers.ts";
import { CreateEndpointBody } from "./routes/webhook-endpoints.ts";

interface Op {
  method: "get" | "post" | "put" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  query?: Record<string, string>;
  scope?: "platform" | "ops" | "none";
  created?: boolean;
}

/** Every route the API serves. A test fails if a route is added without an entry here. */
export const OPERATIONS: Op[] = [
  // Agreements
  {
    method: "post",
    path: "/v1/agreements",
    tag: "Agreements",
    summary: "Create a draft agreement with your own spec",
    body: CreateAgreementBody,
    created: true,
  },
  {
    method: "post",
    path: "/v1/agreements/from-request",
    tag: "Agreements",
    summary:
      "Create a draft; Proof Desk drafts the acceptance criteria from a plain-language request",
    body: FromRequestBody,
    created: true,
  },
  {
    method: "post",
    path: "/v1/agreements/from-mandate",
    tag: "Agreements",
    summary: "Create a draft from an AP2 intent or cart mandate",
    body: FromMandateBody,
    created: true,
  },
  {
    method: "get",
    path: "/v1/agreements",
    tag: "Agreements",
    summary: "List agreements",
    query: { status: "Filter by status", limit: "1-100, default 20" },
  },
  {
    method: "get",
    path: "/v1/agreements/{id}",
    tag: "Agreements",
    summary: "Retrieve an agreement",
  },
  {
    method: "put",
    path: "/v1/agreements/{id}/spec",
    tag: "Agreements",
    summary: "Replace the spec (draft only; changes the spec hash)",
    body: ReplaceSpecBody,
  },
  {
    method: "put",
    path: "/v1/agreements/{id}/inputs",
    tag: "Agreements",
    summary: "Attach source material (draft only; hashed into the spec)",
    body: InputsBody,
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/inputs",
    tag: "Agreements",
    summary: "List source material",
    query: { include_content: "true to include file contents" },
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/approve-spec",
    tag: "Agreements",
    summary: "Buyer approves the exact spec they saw, by hash",
    body: ApproveSpecBody,
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/cancel",
    tag: "Agreements",
    summary: "Cancel before funding",
    body: CancelBody,
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/disputes",
    tag: "Agreements",
    summary: "Dispute a decision within the appeal window",
    body: DisputeBody,
    created: true,
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/ledger",
    tag: "Agreements",
    summary: "The agreement's tamper-evident ledger entries",
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/verifications",
    tag: "Agreements",
    summary: "Verification reports",
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/report-links",
    tag: "Agreements",
    summary: "Create a shareable, read-only verdict report link",
    body: LinkBody,
    created: true,
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/payment-links",
    tag: "Funding",
    summary:
      "Create a hosted page where the buyer pays: card authorization, or USDC from a wallet (also serves x402 at <url>/x402)",
    body: PaymentLinkBody,
    created: true,
  },
  // Funding
  {
    method: "post",
    path: "/v1/agreements/{id}/card-hold",
    tag: "Funding",
    summary: "Authorize the buyer's card (returns client_secret, or confirms with payment_method)",
    body: CardHoldBody,
    created: true,
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/hold",
    tag: "Funding",
    summary: "Card hold status and settlement",
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/onchain-job",
    tag: "Funding",
    summary:
      "Issue the agreement's on-chain job terms (USDC on Base) and how to fund them: wallet calls, or typed data to sign gaslessly",
    body: OnchainJobBody,
    created: true,
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/onchain-job",
    tag: "Funding",
    summary: "On-chain job status and settlement",
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/onchain-job/confirm",
    tag: "Funding",
    summary: "Fund the agreement from the buyer's createAndFund transaction (verified on-chain)",
    body: OnchainConfirmBody,
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/onchain-job/authorization",
    tag: "Funding",
    summary: "Gasless funding: relay the buyer's signed EIP-3009 authorization",
    body: OnchainAuthorizationBody,
    created: true,
  },
  {
    method: "post",
    path: "/v1/agreements/{id}/fund",
    tag: "Funding",
    summary: "Fund with the test rail (sandbox)",
    body: FundBody,
  },
  // Delivery
  {
    method: "post",
    path: "/v1/agreements/{id}/deliveries",
    tag: "Delivery",
    summary: "Seller submits the deliverable (content-addressed)",
    body: DeliveryBody,
    created: true,
  },
  {
    method: "get",
    path: "/v1/agreements/{id}/deliveries",
    tag: "Delivery",
    summary: "List deliveries",
    query: { include_content: "true to include artifact contents" },
  },
  // Billing
  {
    method: "get",
    path: "/v1/billing/usage",
    tag: "Billing",
    summary: "This period's usage and fees (live and test), and what will be invoiced",
    query: { period: "YYYY-MM (default: current month)" },
  },
  { method: "get", path: "/v1/billing/invoices", tag: "Billing", summary: "Your invoices" },
  {
    method: "put",
    path: "/v1/billing/settings",
    tag: "Billing",
    summary: "Set the email invoices are sent to",
    body: BillingSettingsBody,
  },
  {
    method: "post",
    path: "/v1/ops/billing/invoice",
    tag: "Ops",
    summary: "Invoice every account's live usage for a closed month (Stripe Billing)",
    body: PeriodBody,
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/billing/reviewer-payouts",
    tag: "Ops",
    summary: "Pay human reviewers for a closed month",
    body: PeriodBody,
    scope: "ops",
  },
  {
    method: "put",
    path: "/v1/ops/accounts/{id}/plan",
    tag: "Ops",
    summary: "Set an account's plan (standard or verify_only)",
    body: PlanBody,
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/reviewers/me/onboarding",
    tag: "Ops",
    summary: "Link the calling reviewer's payout account (hosted Stripe onboarding)",
    body: ReviewerOnboardingBody,
    scope: "ops",
    created: true,
  },
  // Shadow mode (pilots)
  {
    method: "put",
    path: "/v1/ops/accounts/{id}/shadow-mode",
    tag: "Ops",
    summary: "Turn shadow mode on or off for an account",
    description:
      "In shadow mode every automatic decision for the account waits for a human review before it can settle (even a forced settlement).",
    body: ShadowModeBody,
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/review",
    tag: "Ops",
    summary: "Confirm or override an automatic decision held for shadow review",
    description:
      "Omit `outcome` (or send the same one) to confirm. A different outcome overrides the decision and restarts the appeal window.",
    body: ReviewBody,
    scope: "ops",
  },
  {
    method: "get",
    path: "/v1/ops/reviews/pending",
    tag: "Ops",
    summary: "Automatic decisions awaiting shadow review, earliest appeal deadline first",
    scope: "ops",
  },
  {
    method: "get",
    path: "/v1/ops/reviews/stats",
    tag: "Ops",
    summary: "Shadow-review agreement, false-release and false-refund counts per vertical",
    query: { days: "Window in days (default 90)" },
    scope: "ops",
  },
  {
    method: "get",
    path: "/v1/ops/reviews/golden-candidates",
    tag: "Ops",
    summary: "Reviewer disagreements as golden-set candidates (NDJSON)",
    description:
      "Each line has the spec, inputs, judged delivery, the verifier's outcome and the reviewer's label. Contains customer content.",
    query: { days: "Only reviews from the last N days", limit: "1-500, default 100" },
    scope: "ops",
  },
  {
    method: "get",
    path: "/v1/ops/reviews",
    tag: "Ops",
    summary: "Shadow reviews, newest first",
    query: {
      agreed: "true or false",
      days: "Only reviews from the last N days",
      limit: "1-500, default 100",
    },
    scope: "ops",
  },
  // Sellers
  {
    method: "post",
    path: "/v1/sellers/{ref}/onboarding",
    tag: "Sellers",
    summary: "Create the seller's payout account and get a hosted onboarding link",
    body: OnboardingBody,
    created: true,
  },
  { method: "get", path: "/v1/sellers/{ref}", tag: "Sellers", summary: "Seller payout status" },
  {
    method: "put",
    path: "/v1/sellers/{ref}/wallet",
    tag: "Sellers",
    summary: "Set the seller's USDC payout address (stablecoin rail)",
    body: SellerWalletBody,
  },
  {
    method: "get",
    path: "/v1/sellers/{ref}/wallet",
    tag: "Sellers",
    summary: "The seller's USDC payout address",
  },
  // Webhooks
  {
    method: "post",
    path: "/v1/webhook-endpoints",
    tag: "Webhooks",
    summary: "Register an endpoint (the signing secret is returned once)",
    body: CreateEndpointBody,
    created: true,
  },
  { method: "get", path: "/v1/webhook-endpoints", tag: "Webhooks", summary: "List endpoints" },
  {
    method: "get",
    path: "/v1/webhook-endpoints/{id}/attempts",
    tag: "Webhooks",
    summary: "Recent delivery attempts",
  },
  {
    method: "delete",
    path: "/v1/webhook-endpoints/{id}",
    tag: "Webhooks",
    summary: "Delete an endpoint",
  },
  // Sandbox
  {
    method: "post",
    path: "/v1/test_helpers/agreements/{id}/decide",
    tag: "Sandbox",
    summary: "Simulate the verifier's decision (test keys only)",
    body: SimulateDecisionBody,
  },
  {
    method: "post",
    path: "/v1/test_helpers/agreements/{id}/verify",
    tag: "Sandbox",
    summary: "Run the verifier now (test keys only)",
  },
  {
    method: "post",
    path: "/v1/test_helpers/agreements/{id}/settle",
    tag: "Sandbox",
    summary: "Settle now, skipping the appeal window (test keys only)",
  },
  // Ops
  {
    method: "get",
    path: "/v1/ops/agreements/{id}",
    tag: "Ops",
    summary: "Retrieve any agreement",
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/verify",
    tag: "Ops",
    summary: "Run the verifier on the latest delivery, then decide or escalate",
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/start-verification",
    tag: "Ops",
    summary: "Move a delivered agreement to verifying",
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/decide",
    tag: "Ops",
    summary: "Human decision",
    body: DecideBody,
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/miss-deadline",
    tag: "Ops",
    summary: "Refund an agreement whose seller missed the deadline",
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/resolve-dispute",
    tag: "Ops",
    summary: "Final decision on a dispute",
    body: ResolveDisputeBody,
    scope: "ops",
  },
  {
    method: "post",
    path: "/v1/ops/agreements/{id}/settle",
    tag: "Ops",
    summary: "Move the money for a final decision",
    body: SettleBody,
    scope: "ops",
  },
  { method: "post", path: "/v1/ops/run-due", tag: "Ops", summary: "Scheduler tick", scope: "ops" },
  {
    method: "get",
    path: "/v1/ops/ledger/verify",
    tag: "Ops",
    summary: "Verify the whole ledger hash chain",
    scope: "ops",
  },
  // Unauthenticated
  {
    method: "post",
    path: "/webhooks/stripe",
    tag: "Processor webhooks",
    summary: "Stripe webhook receiver (signature-verified)",
    scope: "none",
  },
  {
    method: "post",
    path: "/v1/ops/ledger/anchor",
    tag: "Ops",
    summary: "Post the ledger head to the on-chain LedgerAnchor now",
    scope: "ops",
  },
  {
    method: "get",
    path: "/v1/ops/ledger/anchors",
    tag: "Ops",
    summary: "Check every on-chain anchor against the ledger",
    scope: "ops",
  },
  { method: "get", path: "/health", tag: "Meta", summary: "Health check", scope: "none" },
  {
    method: "get",
    path: "/accuracy.json",
    tag: "Meta",
    summary: "Production verifier accuracy (live jobs, last 90 days, aggregates only)",
    scope: "none",
  },
  {
    method: "get",
    path: "/status.json",
    tag: "Meta",
    summary: "Component status (scheduler, ledger integrity, payment rails, verifiers)",
    scope: "none",
  },
];

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
    },
  },
};

export function openApiDocument(serverUrl = "http://localhost:8787") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const queryParams = Object.entries(op.query ?? {}).map(([name, description]) => ({
      name,
      in: "query",
      required: false,
      description,
      schema: { type: "string" },
    }));
    const writes = op.method === "post" || op.method === "put";
    const headers =
      writes && op.scope !== "none"
        ? [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              description:
                "Retries with the same key return the original response instead of acting twice.",
              schema: { type: "string", maxLength: 255 },
            },
          ]
        : [];
    const item = paths[op.path] ?? {};
    paths[op.path] = item;
    item[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.scope === "none" ? { security: [] } : {}),
      ...(op.scope === "ops" ? { description: "Requires an API key with the ops scope." } : {}),
      parameters: [...params, ...queryParams, ...headers],
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: stripMeta(
                    zod.toJSONSchema(op.body, { io: "input", unrepresentable: "any" }),
                  ),
                },
              },
            },
          }
        : {}),
      responses: {
        [op.created ? "201" : "200"]: {
          description: "Success",
          content: { "application/json": { schema: { type: "object" } } },
        },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Proof Desk API",
      version: "1.0.0",
      description:
        "Conditional payments for agent and human work: money is held, the deliverable is checked against the approved spec, then released or refunded. Every step is on a tamper-evident ledger.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "pd_test_… (sandbox) or pd_live_… API key",
        },
      },
      schemas: { Error: errorSchema },
    },
    paths,
  };
}

function stripMeta(schema: Record<string, unknown>) {
  const { $schema: _s, ...rest } = schema;
  return rest;
}

/**
 * The reference UI is Scalar, pinned to an exact version with Subresource Integrity, under its
 * own CSP: no inline script, no third-party connections (Scalar's request proxy is blocked, so
 * "try it" calls go straight to this API).
 */
export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.scalar.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof Desk API reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.73.1/dist/browser/standalone.js"
      integrity="sha384-kYDGzV91Jnn3TbHINV3nt54riK2uMJDfN5Al8dAkz4FssELTBWbD8rgw32sTKfOi"
      crossorigin="anonymous"
    ></script>
  </body>
</html>`;
