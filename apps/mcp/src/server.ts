import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Agreement, type ProofDesk, ProofDeskError } from "@proofdesk/sdk";
import { z } from "zod";

/** Minor-unit digits per currency (ISO 4217 via Intl; stablecoins use 6). */
export function toMinor(amount: number, currency: string): number {
  const code = currency.toUpperCase();
  const digits =
    code === "USDC" || code === "USDT"
      ? 6
      : (new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2);
  return Math.round(amount * 10 ** digits);
}

function fromMinor(value: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "USDC" || code === "USDT") return `${(value / 1e6).toFixed(2)} ${code}`;
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(
    value / 10 ** digits,
  );
}

/** What an agent should do next, given where the purchase is. */
function nextStep(a: Agreement, sandbox: boolean): string {
  switch (a.status) {
    case "draft":
      return `Review the acceptance criteria (and any open questions) with the user. If they agree, call approve_purchase_terms with spec_hash "${a.spec_hash}".`;
    case "spec_approved":
      return sandbox
        ? "Call fund_purchase to hold the payment (sandbox: no card needed)."
        : "Call fund_purchase with a shared_payment_token (spt_…) for this amount, or the user's payment_method, to place a card hold.";
    case "funded":
      return "Waiting for the seller to deliver (submit_delivery). Nothing is charged yet.";
    case "delivered":
    case "verifying":
      return sandbox
        ? "Delivered. In the sandbox, call sandbox_run_verification (or sandbox_simulate_decision)."
        : "Delivered; Proof Desk is verifying it against the criteria. Check back with get_purchase.";
    case "escalated":
      return "The checks were inconclusive; a human reviewer will decide. Check back with get_purchase.";
    case "decided":
      return `Decided: ${a.outcome?.kind}. Either side may dispute until ${a.appeal_window_ends_at}; after that the money moves.${sandbox ? " Sandbox: sandbox_settle settles now." : ""}`;
    case "disputed":
      return "A dispute is open; a human reviewer will make the final decision.";
    case "settled":
      return "Settled. The money has moved according to the decision.";
    case "cancelled":
      return "Cancelled. No money moved.";
  }
}

function summarize(a: Agreement, sandbox: boolean) {
  return {
    agreement_id: a.id,
    status: a.status,
    title: a.spec.title,
    amount: fromMinor(a.amount.value, a.amount.currency),
    seller: a.seller_ref,
    deliver_by: a.delivery_due_at,
    acceptance_criteria: a.spec.criteria.map((c) => ({
      id: c.id,
      requirement: c.description,
      how_checked: c.verification ?? c.check,
      critical: c.critical,
    })),
    open_questions: (a.spec_source as { open_questions?: string[] } | null)?.open_questions ?? [],
    warnings: a.spec_warnings.map((w) => w.message),
    spec_hash: a.spec_hash,
    outcome: a.outcome,
    next_step: nextStep(a, sandbox),
  };
}

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

/** Errors go back to the agent as tool errors it can read and act on, not protocol failures. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message =
      err instanceof ProofDeskError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/**
 * MCP server over the Proof Desk API. Buyer agents create a protected purchase, approve its
 * criteria, and fund it; seller agents deliver; nobody is paid until the work passes the checks.
 */
export function createServer(pd: ProofDesk): McpServer {
  const sandbox = !pd.livemode;
  const server = new McpServer({ name: "proof-desk", version: "0.1.0" });

  server.registerTool(
    "create_protected_purchase",
    {
      title: "Create a protected purchase",
      description:
        "Start a purchase where the money is only released if the deliverable meets agreed acceptance criteria. Proof Desk drafts checkable criteria from the request; show them to the user before approving. Nothing is charged yet.",
      inputSchema: {
        request: z.string().min(1).describe("What the buyer wants, in plain language"),
        seller_ref: z
          .string()
          .min(1)
          .describe("Your platform's id for the seller (person or agent)"),
        buyer_ref: z.string().min(1).describe("Your platform's id for the buyer"),
        amount: z.number().positive().describe("Price in major units, e.g. 180 for $180.00"),
        currency: z.string().default("usd"),
        deliver_by: z.iso.datetime({ offset: true }).describe("Delivery deadline (ISO 8601)"),
        vertical: z.enum(["translation", "code", "data", "general"]).optional(),
        source_document: z
          .object({ name: z.string(), content: z.string() })
          .optional()
          .describe("Source material the work is judged against, e.g. the text to translate"),
      },
    },
    (args) =>
      run(async () => {
        const currency = args.currency.toLowerCase();
        let agreement = await pd.agreements.createFromRequest({
          request: args.request,
          buyer_ref: args.buyer_ref,
          seller_ref: args.seller_ref,
          amount: { value: toMinor(args.amount, currency), currency },
          delivery_due_at: args.deliver_by,
          ...(args.vertical ? { vertical: args.vertical } : {}),
        });
        if (args.source_document) {
          agreement = await pd.agreements.replaceInputs(agreement.id, [
            {
              name: args.source_document.name,
              media_type: "text/plain",
              content: args.source_document.content,
            },
          ]);
        }
        return summarize(agreement, sandbox);
      }),
  );

  server.registerTool(
    "verify_work",
    {
      title: "Check work against acceptance criteria",
      description:
        "Check a deliverable (code with the buyer's tests, a dataset against a schema, a research brief's citations, a translation) against acceptance criteria you give, with no payment involved. Returns the verdict with per-criterion evidence, or says a human reviewer will decide. Billed per check.",
      inputSchema: {
        title: z.string().min(1).max(200),
        request: z.string().min(1).describe("What was asked for, in plain language"),
        vertical: z.enum(["translation", "code", "data"]),
        criteria: z
          .array(
            z.object({
              id: z.string().describe("lowercase id, e.g. tests-pass"),
              description: z.string(),
              check: z.enum(["deterministic", "domain", "judge"]).default("judge"),
              critical: z.boolean().default(false),
            }),
          )
          .min(1),
        deliverable: z
          .array(
            z.object({
              name: z.string(),
              content: z.string(),
              media_type: z.string().default("text/plain"),
            }),
          )
          .min(1)
          .describe("The work to check"),
        inputs: z
          .array(
            z.object({
              name: z.string(),
              content: z.string(),
              media_type: z.string().default("text/plain"),
            }),
          )
          .default([])
          .describe("What it's judged against: source text, acceptance tests, a JSON schema"),
      },
    },
    (args) =>
      run(async () => {
        const job = await pd.verifications.create({
          spec: {
            version: 1,
            title: args.title,
            request: args.request,
            vertical: args.vertical,
            criteria: args.criteria,
          },
          deliverable: args.deliverable,
          inputs: args.inputs,
        });
        const report = job.verification?.report as
          | {
              decision?: { reason?: string };
              criteria?: { criterion_id: string; verdict: string }[];
            }
          | undefined;
        return {
          verification_job_id: job.id,
          status: job.status,
          result:
            job.status === "escalated"
              ? "a human reviewer will decide; check back with the job id"
              : (job.outcome?.kind ?? job.status),
          reason: report?.decision?.reason,
          criteria: report?.criteria?.map((c) => `${c.criterion_id}: ${c.verdict}`),
        };
      }),
  );

  server.registerTool(
    "approve_purchase_terms",
    {
      title: "Approve the purchase terms",
      description:
        "Approve the acceptance criteria and price exactly as shown (identified by spec_hash). Only do this after the user has agreed to them.",
      inputSchema: { agreement_id: z.string(), spec_hash: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    (args) =>
      run(async () =>
        summarize(await pd.agreements.approveSpec(args.agreement_id, args.spec_hash), sandbox),
      ),
  );

  server.registerTool(
    "fund_purchase",
    {
      title: "Hold the payment",
      description: sandbox
        ? "Hold the payment for an approved purchase. Sandbox: no card needed; a test hold is placed."
        : "Place a hold on the buyer's card for an approved purchase. The card is only charged if the work passes (or partly, for a partial release).",
      inputSchema: {
        agreement_id: z.string(),
        payment_method: z.string().optional().describe("Stripe PaymentMethod id (live funding)"),
        shared_payment_token: z
          .string()
          .optional()
          .describe(
            "A Stripe shared payment token (spt_…) your agent was granted for at least the purchase amount (MPP/ACP agents)",
          ),
      },
    },
    (args) =>
      run(async () => {
        if (sandbox && !args.payment_method && !args.shared_payment_token) {
          return summarize(
            await pd.agreements.fund(args.agreement_id, {
              rail: "test",
              hold_ref: `mcp_${Date.now()}`,
            }),
            sandbox,
          );
        }
        const res = await pd.agreements.createCardHold(args.agreement_id, {
          ...(args.payment_method ? { payment_method: args.payment_method } : {}),
          ...(args.shared_payment_token ? { shared_payment_token: args.shared_payment_token } : {}),
        });
        return {
          ...summarize(res.agreement, sandbox),
          card_hold: res.hold.status,
          ...(res.payment_intent_status === "requires_capture"
            ? {}
            : {
                client_secret: res.client_secret,
                note: "The buyer must confirm the card with this client_secret.",
              }),
        };
      }),
  );

  server.registerTool(
    "fund_purchase_with_usdc",
    {
      title: "Hold the payment in USDC",
      description:
        "Fund an approved purchase in USDC on Base. The money is locked in a public job contract (not sent to Proof Desk or the seller) and released only if the work passes. Returns typed data for the buyer's wallet to sign (no gas), a hosted payment page, and an x402 URL. After signing, call submit_usdc_authorization.",
      inputSchema: {
        agreement_id: z.string(),
        wallet_address: z
          .string()
          .optional()
          .describe("The buyer's wallet (0x…); include it to get the typed data to sign"),
      },
    },
    (args) =>
      run(async () => {
        const f = await pd.agreements.createOnchainJob(args.agreement_id, {
          ...(args.wallet_address ? { client: args.wallet_address } : {}),
        });
        const link = await pd.agreements.createPaymentLink(args.agreement_id, { rail: "onchain" });
        return {
          network: f.network,
          contract: f.contract,
          token: f.token,
          amount: { base_units: f.terms.budget, currency: "USDC" },
          refundable_by_buyer_after: new Date(f.terms.expired_at * 1000).toISOString(),
          typed_data: f.typed_data,
          payment_page: link.url,
          x402_url: `${link.url}/x402`,
          note: f.typed_data
            ? "Sign typed_data with eth_signTypedData_v4 from wallet_address, then call submit_usdc_authorization."
            : "Open payment_page in a browser wallet, or pass wallet_address to sign directly.",
        };
      }),
  );

  server.registerTool(
    "submit_usdc_authorization",
    {
      title: "Submit the signed USDC authorization",
      description:
        "Submit the buyer's signature of the typed data from fund_purchase_with_usdc. Proof Desk relays it (and pays the gas); the purchase becomes funded.",
      inputSchema: {
        agreement_id: z.string(),
        wallet_address: z.string(),
        valid_before: z.string().describe("typed_data.message.validBefore"),
        signature: z.string().describe("0x… 65-byte signature"),
      },
    },
    (args) =>
      run(async () => {
        const res = await pd.agreements.authorizeOnchainFunding(args.agreement_id, {
          client: args.wallet_address,
          valid_before: args.valid_before,
          signature: args.signature,
        });
        return {
          ...summarize(res.agreement, sandbox),
          job_id: res.job.job_id,
          tx: res.job.fund_tx,
        };
      }),
  );

  server.registerTool(
    "get_purchase",
    {
      title: "Check a purchase",
      description: "Status, acceptance criteria, decision and next step for a protected purchase.",
      inputSchema: { agreement_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const agreement = await pd.agreements.retrieve(args.agreement_id);
        const [latest] = (await pd.agreements.verifications(args.agreement_id)).data;
        const report = latest?.report as
          | {
              criteria?: { criterion_id: string; verdict: string }[];
              decision?: { reason?: string };
            }
          | undefined;
        return {
          ...summarize(agreement, sandbox),
          ...(latest
            ? {
                verification: {
                  result:
                    latest.action === "decide" ? latest.outcome?.kind : "escalated to a human",
                  reason: report?.decision?.reason,
                  criteria: report?.criteria?.map((c) => `${c.criterion_id}: ${c.verdict}`),
                },
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "list_purchases",
    {
      title: "List purchases",
      description: "Recent protected purchases, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum([
            "draft",
            "spec_approved",
            "funded",
            "delivered",
            "verifying",
            "escalated",
            "decided",
            "disputed",
            "settled",
            "cancelled",
          ])
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () =>
        (await pd.agreements.list(args.status ? { status: args.status } : {})).data.map((a) => ({
          agreement_id: a.id,
          status: a.status,
          title: a.spec.title,
          amount: fromMinor(a.amount.value, a.amount.currency),
        })),
      ),
  );

  server.registerTool(
    "submit_delivery",
    {
      title: "Deliver the work (seller)",
      description:
        "Seller side: submit the finished deliverable for a funded purchase. It is hashed and verified against the criteria.",
      inputSchema: {
        agreement_id: z.string(),
        files: z
          .array(
            z.object({
              name: z.string(),
              content: z.string(),
              media_type: z.string().default("text/plain"),
            }),
          )
          .min(1),
      },
    },
    (args) =>
      run(async () => {
        const res = await pd.agreements.deliver(args.agreement_id, args.files);
        return {
          delivery_id: res.delivery_id,
          manifest_hash: res.manifest_hash,
          ...summarize(res.agreement, sandbox),
        };
      }),
  );

  server.registerTool(
    "open_dispute",
    {
      title: "Dispute a decision",
      description:
        "Ask a human reviewer to overturn a decision, within the appeal window. Only the side the decision went against can dispute.",
      inputSchema: {
        agreement_id: z.string(),
        opened_by: z.enum(["buyer", "seller"]),
        reason: z.string().min(1),
      },
    },
    (args) =>
      run(async () =>
        summarize(
          await pd.agreements.openDispute(args.agreement_id, {
            opened_by: args.opened_by,
            reason: args.reason,
          }),
          sandbox,
        ),
      ),
  );

  if (sandbox) {
    server.registerTool(
      "sandbox_run_verification",
      {
        title: "Sandbox: verify the delivery now",
        description:
          "Sandbox only: run Proof Desk's verifier on the delivery right away and apply its decision.",
        inputSchema: { agreement_id: z.string() },
      },
      (args) =>
        run(async () => {
          const res = await pd.testHelpers.verify(args.agreement_id);
          return { ...summarize(res.agreement, sandbox), verification: res.verification?.report };
        }),
    );
    server.registerTool(
      "sandbox_simulate_decision",
      {
        title: "Sandbox: simulate the verifier's decision",
        description:
          "Sandbox only: decide release / refund / partial without running the verifier.",
        inputSchema: {
          agreement_id: z.string(),
          outcome: z.enum(["release", "refund", "partial"]),
          release_percent: z.number().int().min(1).max(99).optional(),
        },
      },
      (args) =>
        run(async () => {
          const outcome =
            args.outcome === "partial"
              ? { kind: "partial" as const, release_percent: args.release_percent ?? 50 }
              : { kind: args.outcome };
          return summarize(await pd.testHelpers.decide(args.agreement_id, outcome), sandbox);
        }),
    );
    server.registerTool(
      "sandbox_settle",
      {
        title: "Sandbox: settle now",
        description:
          "Sandbox only: settle a decided purchase immediately, skipping the appeal window.",
        inputSchema: { agreement_id: z.string() },
      },
      (args) => run(async () => summarize(await pd.testHelpers.settle(args.agreement_id), sandbox)),
    );
  }

  return server;
}
