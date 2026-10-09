import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, verifiersOf } from "../env.ts";
import { ApiError } from "../errors.ts";
import { agreementJson, verificationJson } from "../serialize.ts";
import type { AgreementRow } from "../services/agreements.ts";
import { listVerifications } from "../services/verification.ts";
import {
  createVerification,
  getVerificationJob,
  listVerificationJobs,
  runVerification,
  verifyOnlySpec,
} from "../services/verify-only.ts";

const file = z.object({
  name: z.string().min(1).max(255),
  media_type: z.string().min(1).max(100),
  content: z.string().max(1_000_000),
});

export const VerifyBody = z.object({
  /**
   * The acceptance criteria, as in an agreement spec. `amount`, `delivery_due_at` and
   * `appeal_window_hours` are optional here: nothing is held, the delivery comes with the
   * request, and there's no appeal window unless you ask for one.
   */
  spec: z.record(z.string(), z.unknown()),
  inputs: z.array(file).max(20).default([]),
  deliverable: z.array(file).min(1).max(20),
  buyer_ref: z.string().min(1).max(255).default("verify_api_buyer"),
  seller_ref: z.string().min(1).max(255).default("verify_api_seller"),
  metadata: z.record(z.string().max(40), z.string().max(500)).default({}),
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/**
 * The Verify API: check agent or human work against acceptance criteria with no payment held.
 * Billed per check. Escalated jobs are decided by a human; the result arrives by webhook and
 * on GET.
 */
export function verificationRoutes(deps: AppDeps) {
  const { db, now } = deps;
  const r = new Hono<AppEnv>();
  const verifiers = () => verifiersOf(deps);

  async function jobJson(row: AgreementRow) {
    const [latest] = await listVerifications(db, row.id);
    return {
      id: row.id,
      object: "verification_job",
      livemode: row.livemode,
      status: row.status,
      outcome: agreementJson(row).outcome,
      decided_at: row.decidedAt?.toISOString() ?? null,
      review_pending: row.reviewPending,
      spec_hash: row.specHash,
      verification: latest ? verificationJson(latest) : null,
      metadata: row.metadata,
      created_at: row.createdAt.toISOString(),
    };
  }

  r.post("/", async (c) => {
    const body = VerifyBody.parse(await c.req.json());
    const auth = c.get("auth");
    const vertical = body.spec.vertical;
    if (vertical === "general") {
      throw new ApiError(
        422,
        "no_automated_verifier",
        'there\'s no automated verifier for "general" jobs; use an agreement and decide by hand',
      );
    }
    const row = await createVerification(db, verifiers(), {
      accountId: auth.accountId,
      livemode: auth.mode === "live",
      spec: verifyOnlySpec(body.spec, now()),
      inputs: body.inputs,
      deliverable: body.deliverable,
      buyerRef: body.buyer_ref,
      sellerRef: body.seller_ref,
      metadata: body.metadata,
      now,
    });
    return c.json(await jobJson(row), 201);
  });

  r.get("/", async (c) => {
    const q = ListQuery.parse(c.req.query());
    const rows = await listVerificationJobs(db, c.get("auth").accountId, q.limit);
    return c.json({ object: "list", data: await Promise.all(rows.map(jobJson)) });
  });

  r.get("/:id", async (c) => {
    const row = await getVerificationJob(db, c.req.param("id"), {
      accountId: c.get("auth").accountId,
    });
    return c.json(await jobJson(row));
  });

  /** Re-run a job the verifier couldn't finish (e.g. the model or sandbox was unavailable). */
  r.post("/:id/retry", async (c) => {
    const job = await getVerificationJob(db, c.req.param("id"), {
      accountId: c.get("auth").accountId,
    });
    const row = await runVerification(db, verifiers(), job.id, now);
    return c.json(await jobJson(row));
  });

  return r;
}
