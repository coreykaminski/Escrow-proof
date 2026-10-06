import { newId, sha256Hex } from "@proofdesk/core";
import { appendLedgerEntry, type Db, schema } from "@proofdesk/db";
import { asc, eq } from "drizzle-orm";
import { ApiError, notFound } from "../errors.ts";
import { type AgreementRow, lockAgreement, type Scope, specColumns } from "./agreements.ts";

export interface InputFile {
  name: string;
  media_type: string;
  content: string;
}

/**
 * Replaces an agreement's source material (draft only). The files' hashes go into spec.inputs,
 * so the spec hash changes and the buyer approves the exact inputs along with the criteria.
 */
export async function replaceInputs(
  db: Db,
  id: string,
  scope: Scope,
  files: InputFile[],
  now: Date,
): Promise<AgreementRow> {
  const names = new Set<string>();
  for (const f of files) {
    if (names.has(f.name)) {
      throw new ApiError(400, "duplicate_input_name", `two inputs are named "${f.name}"`);
    }
    names.add(f.name);
  }
  const rows = files.map((f) => ({
    id: newId("input", now.getTime()),
    agreementId: id,
    name: f.name,
    mediaType: f.media_type,
    content: f.content,
    sha256: sha256Hex(f.content),
    createdAt: now,
  }));
  const manifest = rows.map((r) => ({ name: r.name, media_type: r.mediaType, sha256: r.sha256 }));

  return db.transaction(async (tx) => {
    const current = await lockAgreement(tx, id, scope);
    if (current.status !== "draft") {
      throw new ApiError(
        409,
        "spec_locked",
        `inputs can't change once status is "${current.status}"`,
      );
    }
    await tx.delete(schema.agreementInputs).where(eq(schema.agreementInputs.agreementId, id));
    if (rows.length) await tx.insert(schema.agreementInputs).values(rows);
    const [row] = await tx
      .update(schema.agreements)
      .set({
        ...specColumns(current.spec, manifest),
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.agreements.id, id))
      .returning();
    if (!row) throw notFound("agreement");
    await appendLedgerEntry(tx, {
      agreementId: id,
      type: "agreement.inputs_replaced",
      payload: {
        previous_spec_hash: current.specHash,
        spec_hash: row.specHash,
        version: row.version,
        inputs: manifest,
      },
      createdAt: now,
    });
    return row;
  });
}

export async function listInputs(db: Db, agreementId: string) {
  return db
    .select()
    .from(schema.agreementInputs)
    .where(eq(schema.agreementInputs.agreementId, agreementId))
    .orderBy(asc(schema.agreementInputs.name));
}
