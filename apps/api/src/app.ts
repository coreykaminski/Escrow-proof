import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./env.ts";
import { ApiError, errorResponse } from "./errors.ts";
import { authenticate, idempotency, requireScope } from "./middleware.ts";
import { DOCS_HTML, openApiDocument } from "./openapi.ts";
import { agreementRoutes } from "./routes/agreements.ts";
import { opsRoutes } from "./routes/ops.ts";
import { sellerRoutes } from "./routes/sellers.ts";
import { testHelperRoutes } from "./routes/test-helpers.ts";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => errorResponse(c, new ApiError(404, "route_not_found", "no such route")));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(openApiDocument(deps.publicUrl)));
  app.get("/docs", (c) => c.html(DOCS_HTML));
  app.route("/webhooks", webhookRoutes(deps));

  app.use("/v1/*", authenticate(deps), idempotency(deps));
  app.use("/v1/agreements/*", requireScope("platform"));
  app.use("/v1/agreements", requireScope("platform"));
  app.use("/v1/sellers/*", requireScope("platform"));
  app.use("/v1/webhook-endpoints/*", requireScope("platform"));
  app.use("/v1/webhook-endpoints", requireScope("platform"));
  app.use("/v1/test_helpers/*", requireScope("platform"));
  app.use("/v1/ops/*", requireScope("ops"));

  app.route("/v1/agreements", agreementRoutes(deps));
  app.route("/v1/sellers", sellerRoutes(deps));
  app.route("/v1/webhook-endpoints", webhookEndpointRoutes(deps));
  app.route("/v1/test_helpers", testHelperRoutes(deps));
  app.route("/v1/ops", opsRoutes(deps));

  return app;
}
