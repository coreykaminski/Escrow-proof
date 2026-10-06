import { TransitionError, type TransitionErrorCode } from "@proofdesk/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

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
};

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
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

export function errorResponse(c: Context, err: unknown) {
  const apiError = toApiError(err);
  if (apiError.status >= 500) console.error(err);
  return c.json(
    {
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
      },
    },
    apiError.status,
  );
}
