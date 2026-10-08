import type { z } from "zod";
import { z as zod } from "zod";
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
  ReplaceSpecBody,
  ResolveDisputeBody,
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
    summary: "Create a hosted page where the buyer authorizes their card",
    body: LinkBody,
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
  { method: "get", path: "/health", tag: "Meta", summary: "Health check", scope: "none" },
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

export const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof Desk API reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
