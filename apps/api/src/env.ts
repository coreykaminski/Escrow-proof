import type { ChainGateway } from "@proofdesk/chain";
import type { ApiScope, Db } from "@proofdesk/db";
import type { PaymentsGateway } from "@proofdesk/payments";
import type { SpecDrafter } from "@proofdesk/spec-engine";
import type {
  CodeVerifier,
  DataVerifier,
  TranslationVerifier,
  Verifiers,
} from "./services/verification.ts";

export interface AppDeps {
  db: Db;
  /** Injectable clock so tests can move time past deadlines and appeal windows. */
  now: () => Date;
  /** Drafts criteria from plain-language requests. Absent → drafting endpoints return 503. */
  drafter?: SpecDrafter;
  /** Automated translation verifier. Absent → POST /v1/ops/agreements/:id/verify returns 503. */
  verifier?: TranslationVerifier;
  /** Code verifier (sandboxed tests). Absent → code jobs return 503 on verify. */
  codeVerifier?: CodeVerifier;
  /** Data/research verifier. Absent → data jobs return 503 on verify. */
  dataVerifier?: DataVerifier;
  /** Card processor (Stripe). Absent → card funding and card settlement return 503. */
  payments?: PaymentsGateway;
  /** Stablecoin rail (ProofDeskJobs on Base). Absent → on-chain funding returns 503. */
  chain?: ChainGateway;
  /** Public base URL of this API, for Stripe onboarding return/refresh links. */
  publicUrl?: string;
  /** Stripe publishable key (pk_…), for the hosted card page. */
  stripePublishableKey?: string;
  /** HTTP client for outbound webhooks (injectable for tests). */
  fetch?: typeof fetch;
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

export const verifiersOf = (d: AppDeps): Verifiers => ({
  translation: d.verifier,
  code: d.codeVerifier,
  data: d.dataVerifier,
});
