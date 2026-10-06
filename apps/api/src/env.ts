import type { ApiScope, Db } from "@proofdesk/db";
import type { SpecDrafter } from "@proofdesk/spec-engine";

export interface AppDeps {
  db: Db;
  /** Injectable clock so tests can move time past deadlines and appeal windows. */
  now: () => Date;
  /** Drafts criteria from plain-language requests. Absent → drafting endpoints return 503. */
  drafter?: SpecDrafter;
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
