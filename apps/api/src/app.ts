import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { dashboardRoutes, publicLinkRoutes } from "./dashboard/routes.tsx";
import type { AppDeps, AppEnv } from "./env.ts";
import { ApiError, errorResponse } from "./errors.ts";
import { authenticate, idempotency, requireScope } from "./middleware.ts";
import { DOCS_CSP, DOCS_HTML, openApiDocument } from "./openapi.ts";
import { agreementRoutes } from "./routes/agreements.ts";
import { billingRoutes, opsBillingRoutes } from "./routes/billing.ts";
import { opsRoutes } from "./routes/ops.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { sellerRoutes } from "./routes/sellers.ts";
import { testHelperRoutes } from "./routes/test-helpers.ts";
import { verificationRoutes } from "./routes/verifications.ts";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { clientIp, MemoryRateLimitStore, rateLimit, securityHeaders } from "./security.ts";
import { lastAnchor } from "./services/anchoring.ts";
import { evaluatorListing } from "./services/evaluator-listing.ts";
import { consistencyProof, treeHead } from "./services/proofs.ts";

/** Per-key and per-IP request limits (override with AppDeps.rateLimits). */
export const DEFAULT_LIMITS = {
  /** Requests per minute per API key. */
  apiPerMinute: 600,
  /** Dashboard sign-in attempts per 15 minutes per IP. */
  loginPer15Minutes: 10,
  /** Share and payment link requests per minute per IP. */
  publicPerMinute: 120,
};

const MB = 1024 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => errorResponse(c, new ApiError(404, "route_not_found", "no such route")));

  const limits = { ...DEFAULT_LIMITS, ...deps.rateLimits };
  const store = deps.rateLimitStore ?? new MemoryRateLimitStore();
  const ip = (c: Parameters<typeof clientIp>[0]) => clientIp(c, deps.trustProxy === true);
  const tooLarge = (max: number) =>
    bodyLimit({
      maxSize: max,
      onError: (c) =>
        errorResponse(
          c,
          new ApiError(413, "payload_too_large", `request body over ${max / MB} MB`),
        ),
    });

  app.use("*", securityHeaders(deps.publicUrl));
  // Deliveries carry up to 20 artifacts of 1 MB each.
  app.use("/v1/*", tooLarge(24 * MB));
  app.use("/webhooks/*", tooLarge(1 * MB));
  app.use("/dashboard/*", tooLarge(MB / 4));
  app.use("/pay/*", tooLarge(MB / 16));
  const login = rateLimit({
    name: "login",
    limit: limits.loginPer15Minutes,
    windowMs: 15 * 60_000,
    key: (c) => (c.req.method === "POST" ? ip(c) : null),
    store,
  });
  app.use("/dashboard/login", login);
  const publicLinks = rateLimit({
    name: "public",
    limit: limits.publicPerMinute,
    windowMs: 60_000,
    key: ip,
    store,
  });
  app.use("/pay/*", publicLinks);
  app.use("/r/*", publicLinks);
  app.use("/ledger/*", publicLinks);

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(openApiDocument(deps.publicUrl)));
  // The ledger's current Merkle tree head and the last one anchored on-chain (public, no content).
  app.get("/ledger/checkpoint.json", async (c) => {
    const [head, anchor] = await Promise.all([treeHead(deps.db), lastAnchor(deps.db)]);
    return c.json({
      object: "ledger_checkpoint",
      ...head,
      anchored: anchor?.root
        ? {
            size: anchor.seq,
            root: anchor.root,
            chain_id: anchor.chain_id,
            contract: anchor.contract,
            tx_hash: anchor.tx_hash,
            anchored_at: anchor.at.toISOString(),
          }
        : null,
    });
  });
  app.get("/ledger/consistency.json", async (c) => {
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
      throw new ApiError(400, "validation_error", "from and to must be tree sizes");
    }
    return c.json(await consistencyProof(deps.db, from, to));
  });
  app.get("/.well-known/erc8183-evaluator.json", async (c) => {
    const listing = await evaluatorListing(deps);
    if (!listing)
      throw new ApiError(404, "chain_unavailable", "the stablecoin rail isn't configured");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(listing);
  });
  app.get("/docs", (c) => {
    c.header("Content-Security-Policy", DOCS_CSP);
    return c.html(DOCS_HTML);
  });
  app.route("/webhooks", webhookRoutes(deps));
  app.route("/dashboard", dashboardRoutes(deps));
  app.route("/", publicLinkRoutes(deps));

  app.use(
    "/v1/*",
    authenticate(deps),
    rateLimit({
      name: "api",
      limit: limits.apiPerMinute,
      windowMs: 60_000,
      key: (c) => (c.get("auth") as { apiKeyId: string }).apiKeyId,
      store,
    }),
    idempotency(deps),
  );
  app.use("/v1/agreements/*", requireScope("platform"));
  app.use("/v1/agreements", requireScope("platform"));
  app.use("/v1/sellers/*", requireScope("platform"));
  app.use("/v1/verifications/*", requireScope("platform"));
  app.use("/v1/verifications", requireScope("platform"));
  app.use("/v1/webhook-endpoints/*", requireScope("platform"));
  app.use("/v1/webhook-endpoints", requireScope("platform"));
  app.use("/v1/test_helpers/*", requireScope("platform"));
  app.use("/v1/billing/*", requireScope("platform"));
  app.use("/v1/ops/*", requireScope("ops"));

  app.route("/v1/agreements", agreementRoutes(deps));
  app.route("/v1/sellers", sellerRoutes(deps));
  app.route("/v1/verifications", verificationRoutes(deps));
  app.route("/v1/webhook-endpoints", webhookEndpointRoutes(deps));
  app.route("/v1/test_helpers", testHelperRoutes(deps));
  app.route("/v1/ops", opsRoutes(deps));
  app.route("/v1/ops", opsBillingRoutes(deps));
  app.route("/v1/ops", reviewRoutes(deps));
  app.route("/v1/billing", billingRoutes(deps));

  return app;
}
