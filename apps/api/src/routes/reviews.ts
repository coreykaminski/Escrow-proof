import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv } from "../env.ts";
import { agreementJson } from "../serialize.ts";
import {
  goldenCandidates,
  listReviews,
  pendingReviews,
  reviewDecision,
  reviewJson,
  setShadowMode,
  shadowStats,
} from "../services/reviews.ts";
import { OutcomeBody } from "./schemas.ts";

export const ShadowModeBody = z.object({ enabled: z.boolean() });
export const ReviewBody = z.object({
  /** Omit to confirm the automatic decision; give a different outcome to override it. */
  outcome: OutcomeBody.optional(),
  reason: z.string().trim().min(1).max(2_000),
});
const ListQuery = z.object({
  agreed: z.enum(["true", "false"]).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const DAY = 86_400_000;

/** Ops: shadow mode for pilot accounts and the reviews it produces. */
export function reviewRoutes({ db, now }: AppDeps) {
  const r = new Hono<AppEnv>();

  r.put("/accounts/:id/shadow-mode", async (c) => {
    const body = ShadowModeBody.parse(await c.req.json());
    const row = await setShadowMode(db, c.req.param("id"), body.enabled);
    return c.json({ id: row.id, object: "account", name: row.name, shadow_mode: row.shadowMode });
  });

  r.post("/agreements/:id/review", async (c) => {
    const body = ReviewBody.parse(await c.req.json());
    const { agreement, review } = await reviewDecision(db, {
      agreementId: c.req.param("id"),
      outcome: body.outcome ?? null,
      reason: body.reason,
      reviewerKeyId: c.get("auth").apiKeyId,
      now: now(),
    });
    return c.json({ agreement: agreementJson(agreement), review: reviewJson(review) });
  });

  r.get("/reviews/pending", async (c) => {
    const rows = await pendingReviews(db);
    return c.json({
      object: "list",
      data: rows.map((p) => ({
        agreement: agreementJson(p.agreement),
        appeal_window_ends_at: p.appealEndsAt?.toISOString() ?? null,
      })),
    });
  });

  r.get("/reviews/stats", async (c) => {
    const q = ListQuery.parse(c.req.query());
    return c.json(await shadowStats(db, new Date(now().getTime() - (q.days ?? 90) * DAY)));
  });

  /** Disagreements as golden-set candidates, one JSON object per line. */
  r.get("/reviews/golden-candidates", async (c) => {
    const q = ListQuery.parse(c.req.query());
    const items = await goldenCandidates(db, {
      limit: q.limit,
      ...(q.days ? { since: new Date(now().getTime() - q.days * DAY) } : {}),
    });
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return c.body(items.map((i) => `${JSON.stringify(i)}\n`).join(""));
  });

  r.get("/reviews", async (c) => {
    const q = ListQuery.parse(c.req.query());
    const rows = await listReviews(db, {
      limit: q.limit,
      ...(q.agreed ? { agreed: q.agreed === "true" } : {}),
      ...(q.days ? { since: new Date(now().getTime() - q.days * DAY) } : {}),
    });
    return c.json({ object: "list", data: rows.map(reviewJson) });
  });

  return r;
}
