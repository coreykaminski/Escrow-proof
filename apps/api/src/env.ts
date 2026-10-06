import type { ApiScope, Db } from "@proofdesk/db";

export interface AppDeps {
  db: Db;
  /** Injectable clock so tests can move time past deadlines and appeal windows. */
  now: () => Date;
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
