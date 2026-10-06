import { randomBytes } from "node:crypto";
import { newId, sha256Hex } from "@proofdesk/core";
import { type ApiScope, type Db, schema } from "@proofdesk/db";

export function generateApiKey(mode: "test" | "live"): string {
  return `pd_${mode}_${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

/** Creates an account and its first API key. The plaintext key is returned once, never stored. */
export async function createAccountWithKey(
  db: Db,
  opts: { name: string; mode?: "test" | "live"; scopes?: ApiScope[] },
) {
  const mode = opts.mode ?? "test";
  const scopes = opts.scopes ?? ["platform"];
  const accountId = newId("account");
  const key = generateApiKey(mode);

  await db.transaction(async (tx) => {
    await tx.insert(schema.accounts).values({ id: accountId, name: opts.name });
    await tx.insert(schema.apiKeys).values({
      id: newId("apiKey"),
      accountId,
      prefix: key.slice(0, 12),
      keyHash: hashApiKey(key),
      mode,
      scopes,
    });
  });

  return { accountId, apiKey: key, mode, scopes };
}
