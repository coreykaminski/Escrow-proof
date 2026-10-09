import { TransitionError, type TransitionErrorCode } from "@proofdesk/core";
import { GatewayError } from "@proofdesk/payments";
import {
  MandateError,
  SpecDraftError,
  type SpecDraftErrorCode,
  TemplateError,
} from "@proofdesk/spec-engine";
import {
  ModelCallError,
  SandboxUnavailableError,
  VerificationInputError,
} from "@proofdesk/verifier";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { type Alerter, type Logger, routeOf } from "./observability.ts";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);

const TRANSITION_STATUS: Record<TransitionErrorCode, ContentfulStatusCode> = {
  invalid_transition: 409,
  forbidden_actor: 403,
  spec_hash_mismatch: 409,
  deadline_passed: 409,
  deadline_not_passed: 409,
  appeal_window_closed: 409,
  appeal_window_open: 409,
  dispute_already_resolved: 409,
  nothing_to_dispute: 409,
  invalid_outcome: 400,
  no_review_pending: 409,
  review_pending: 409,
};

/** Drafting failures: the model's refusal is final for that request; the rest can be retried. */
const DRAFT_ERRORS: Record<SpecDraftErrorCode, [ContentfulStatusCode, string]> = {
  refused: [422, "spec_draft_refused"],
  unavailable: [503, "spec_engine_unavailable"],
  failed: [502, "spec_draft_failed"],
  invalid_draft: [502, "spec_draft_invalid"],
};

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof SpecDraftError) {
    const [status, code] = DRAFT_ERRORS[err.code];
    return new ApiError(status, code, err.message);
  }
  if (err instanceof VerificationInputError) {
    return new ApiError(422, "verification_input_invalid", err.message);
  }
  if (err instanceof SandboxUnavailableError) {
    return new ApiError(503, "verifier_unavailable", "the code sandbox is unavailable; retry");
  }
  if (err instanceof ModelCallError) {
    const [status, code]: [ContentfulStatusCode, string] =
      err.code === "refused"
        ? [422, "verification_refused"]
        : err.code === "unavailable"
          ? [503, "verifier_unavailable"]
          : [502, "verification_failed"];
    return new ApiError(status, code, err.message);
  }
  if (err instanceof GatewayError) {
    return err.retryable
      ? new ApiError(
          503,
          "payment_processor_unavailable",
          "the card processor is unavailable; retry",
        )
      : new ApiError(502, "payment_processor_error", err.message, {
          processor_code: err.code ?? null,
        });
  }
  if (err instanceof TemplateError) {
    return new ApiError(
      err.code === "unknown_template" ? 404 : 400,
      err.code,
      err.message,
      err.details,
    );
  }
  if (err instanceof MandateError) {
    return new ApiError(err.code === "mandate_expired" ? 409 : 400, err.code, err.message);
  }
  if (err instanceof TransitionError) {
    return new ApiError(TRANSITION_STATUS[err.code], err.code, err.message);
  }
  if (err instanceof ZodError) {
    return new ApiError(
      400,
      "validation_error",
      "request failed validation",
      err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  if (err instanceof SyntaxError) {
    return new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
  return new ApiError(500, "internal_error", "an unexpected error occurred");
}

export function errorResponse(
  c: Context,
  err: unknown,
  obs: { logger?: Logger; alerter?: Alerter } = {},
) {
  const apiError = toApiError(err);
  const requestId = (c.get("requestId" as never) as string | undefined) ?? undefined;
  if (apiError.status >= 500) {
    const fields = {
      request_id: requestId,
      route: routeOf(c),
      code: apiError.code,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
    if (obs.logger) obs.logger.error("server error", fields);
    else console.error(err);
    if (apiError.status === 500) {
      void obs.alerter?.notify("server_error", `500 on ${fields.route}`, {
        request_id: requestId,
        code: apiError.code,
      });
    }
  }
  return c.json(
    {
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
    apiError.status,
  );
}
