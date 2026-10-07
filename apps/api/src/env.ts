import type { ApiScope, Db } from "@proofdesk/db";
import type { PaymentsGateway } from "@proofdesk/payments";
import type { SpecDrafter } from "@proofdesk/spec-engine";
import type { TranslationVerifier } from "./services/verification.ts";

export interface AppDeps {
  db: Db;
  /** Injectable clock so tests can move time past deadlines and appeal windows. */
  now: () => Date;
  /** Drafts criteria from plain-language requests. Absent → drafting endpoints return 503. */
  drafter?: SpecDrafter;
  /** Automated translation verifier. Absent → POST /v1/ops/agreements/:id/verify returns 503. */
  verifier?: TranslationVerifier;
  /** Card processor (Stripe). Absent → card funding and card settlement return 503. */
  payments?: PaymentsGateway;
  /** Public base URL of this API, for Stripe onboarding return/refresh links. */
  publicUrl?: string;
}

export interface AuthContext {
  accountId: string;
  apiKeyId: string;
  mode: "test" | "live";
  scopes: ApiScope[];
}

export interface AppEnv {
  Variables: {
    auth: AuthContext;
  };
}
