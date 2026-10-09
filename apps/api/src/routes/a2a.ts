/**
 * Agent2Agent (A2A, protocol 1.0, HTTP+JSON binding) for the verification skill, and the agent
 * card that advertises it at /.well-known/agent-card.json. Another agent sends a message with
 * one JSON data part shaped like a Verify API request (spec + deliverable + optional inputs);
 * Proof Desk runs the verifier and returns a Task whose artifact is the verdict. Under the
 * hood every task is a Verify API job, so it's ledgered, billed per check and, when the
 * verifier escalates, decided by a human (the task stays WORKING until then).
 *
 * Only what is implemented is advertised: message:send and tasks/{id}, no streaming or push.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, verifiersOf } from "../env.ts";
import { ApiError, toApiError } from "../errors.ts";
import { outcomeToJson } from "../services/agreements.ts";
import { listVerifications } from "../services/verification.ts";
import { createVerification, getVerificationJob, verifyOnlySpec } from "../services/verify-only.ts";
import { VerifyBody } from "./verifications.ts";

export const A2A_PROTOCOL_VERSION = "1.0";
const SKILL_ID = "verify-deliverable";

export function agentCard(baseUrl: string) {
  return {
    name: "Proof Desk",
    description:
      "Neutral verifier for agent work: checks a deliverable against acceptance criteria (the buyer's tests run in a sandbox for code; schema, citation and quote checks for data and research; error checks and model judges for translation) and returns a verdict with per-criterion evidence. Uncertain cases go to a human reviewer. Every verdict is written to a hash-chained ledger anchored on-chain.",
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: "Proof Desk", url: baseUrl },
    version: "0.1.0",
    documentationUrl: `${baseUrl}/docs`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      proofdesk_api_key: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description:
            "A Proof Desk platform API key (pd_test_… or pd_live_…). Checks are billed to its account.",
        },
      },
    },
    securityRequirements: [{ schemes: { proofdesk_api_key: { list: [] } } }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: SKILL_ID,
        name: "Verify work against acceptance criteria",
        description:
          'Send one data part (mediaType application/json) shaped like POST /v1/verifications: {"spec": {"version": 1, "title", "request", "vertical": "code" | "data" | "translation", "criteria": [{"id", "description", "check", "critical"}]}, "deliverable": [{"name", "media_type", "content"}], "inputs": [...]} (inputs: the buyer\'s tests, a JSON schema, or the source text). The task completes with a "verdict" artifact: outcome (release = passed, refund = failed, partial), the reason and each criterion\'s verdict. If a human must decide, the task stays working; poll tasks/{id}.',
        tags: [
          "verification",
          "acceptance-testing",
          "code",
          "data",
          "research",
          "translation",
          "erc-8183-evaluator",
        ],
        examples: [
          "Run these acceptance tests against this code and tell me if it passes.",
          "Check that this CSV matches the schema and has at least 100 unique rows.",
          "Check that every citation in this research brief loads and every quote is verbatim.",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

type Job = Awaited<ReturnType<typeof getVerificationJob>>;

const STATE: Record<string, string> = {
  decided: "TASK_STATE_COMPLETED",
  settled: "TASK_STATE_COMPLETED",
  disputed: "TASK_STATE_WORKING",
  escalated: "TASK_STATE_WORKING",
  verifying: "TASK_STATE_FAILED",
  delivered: "TASK_STATE_FAILED",
};

const agentText = (text: string) => ({
  messageId: randomUUID(),
  role: "ROLE_AGENT",
  parts: [{ text }],
});

export function a2aRoutes(deps: AppDeps) {
  const { db, now } = deps;
  const r = new Hono<AppEnv>();

  async function taskJson(job: Job) {
    const [v] = await listVerifications(db, job.id);
    const report = v?.report as
      | {
          decision?: { reason?: string };
          criteria?: { criterion_id: string; verdict: string; rationale?: string }[];
        }
      | undefined;
    const done = (job.status === "decided" || job.status === "settled") && !job.reviewPending;
    const state = job.reviewPending
      ? "TASK_STATE_WORKING"
      : (STATE[job.status] ?? "TASK_STATE_WORKING");
    return {
      id: job.id,
      contextId: job.metadata.a2a_context_id ?? job.id,
      status: {
        state,
        timestamp: (job.decidedAt ?? job.updatedAt).toISOString(),
        ...(state === "TASK_STATE_WORKING"
          ? {
              message: agentText("A human reviewer is deciding this one; check back on this task."),
            }
          : state === "TASK_STATE_FAILED"
            ? {
                message: agentText(
                  "The verifier was unavailable; the check can be retried (POST /v1/verifications/{id}/retry).",
                ),
              }
            : {}),
      },
      artifacts: done
        ? [
            {
              artifactId: `${job.id}-verdict`,
              name: "verdict",
              description: "Proof Desk's verdict on the deliverable",
              parts: [
                {
                  mediaType: "application/json",
                  data: {
                    verification_job_id: job.id,
                    outcome: job.outcome ? outcomeToJson(job.outcome) : null,
                    passed: job.outcome?.kind === "release",
                    reason: report?.decision?.reason ?? null,
                    criteria: report?.criteria?.map((c) => ({
                      id: c.criterion_id,
                      verdict: c.verdict,
                      ...(c.rationale ? { rationale: c.rationale } : {}),
                    })),
                    engine_version: v?.engineVersion ?? null,
                    report_hash: v?.reportHash ?? null,
                    spec_hash: job.specHash,
                  },
                },
              ],
            },
          ]
        : [],
    };
  }

  // A2A-Version: empty means 0.3 (whose messages look the same for this skill); others refused.
  r.use("*", async (c, next) => {
    const v = c.req.header("A2A-Version");
    if (v && v !== A2A_PROTOCOL_VERSION && v !== "0.3") {
      throw new ApiError(400, "version_not_supported", `A2A-Version ${v} isn't supported; use 1.0`);
    }
    await next();
  });

  r.post("/message:send", async (c) => {
    const body = (await c.req.json()) as {
      message?: {
        messageId?: string;
        contextId?: string;
        parts?: { data?: unknown; mediaType?: string }[];
      };
    };
    const message = body.message;
    if (!message?.messageId || !Array.isArray(message.parts)) {
      throw new ApiError(400, "invalid_request", "message with messageId and parts is required");
    }
    const data = message.parts.find((p) => p.data !== undefined)?.data;
    const parsed = VerifyBody.safeParse(data);
    if (!parsed.success) {
      return c.json({
        message: agentText(
          'Send one data part shaped like a Verify API request: {"spec": {...}, "deliverable": [...], "inputs": [...]}. See the verify-deliverable skill in the agent card.',
        ),
      });
    }
    if (parsed.data.spec.vertical === "general") {
      return c.json({
        message: agentText(
          'There\'s no automated verifier for "general" work; use code, data or translation.',
        ),
      });
    }
    const auth = c.get("auth");
    const contextId = message.contextId ?? randomUUID();
    let job: Job;
    try {
      job = await createVerification(db, verifiersOf(deps), {
        accountId: auth.accountId,
        livemode: auth.mode === "live",
        spec: verifyOnlySpec(parsed.data.spec, now()),
        inputs: parsed.data.inputs,
        deliverable: parsed.data.deliverable,
        buyerRef: parsed.data.buyer_ref,
        sellerRef: parsed.data.seller_ref,
        metadata: {
          ...parsed.data.metadata,
          a2a_context_id: contextId.slice(0, 500),
          a2a_message_id: message.messageId.slice(0, 500),
        },
        now,
      });
    } catch (err) {
      const api = toApiError(err);
      const id = (api.details as { verification_job_id?: string } | undefined)?.verification_job_id;
      if (!id) throw err;
      job = await getVerificationJob(db, id, { accountId: auth.accountId });
    }
    return c.json({ task: await taskJson(job) });
  });

  r.get("/tasks/:id", async (c) => {
    const job = await getVerificationJob(db, c.req.param("id"), {
      accountId: c.get("auth").accountId,
    });
    return c.json(await taskJson(job));
  });

  return r;
}
