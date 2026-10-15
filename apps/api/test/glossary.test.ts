/** Glossary adherence through the API: a translation job with an attached glossary.csv. */
import {
  ANNOTATOR_MODEL,
  type Annotation,
  type Judgment,
  type StructuredCaller,
  verifyTranslation,
} from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** The model layers find nothing wrong: only the deterministic checks decide. */
const allClear: StructuredCaller = {
  async call<S extends z.ZodType>(p: { model: string; user: string }) {
    const ids = [...p.user.matchAll(/^- ([a-z0-9-]+)/gm)].map((m) => m[1] as string);
    const output: Annotation | Judgment =
      p.model === ANNOTATOR_MODEL
        ? { errors: [], injection_detected: false }
        : {
            criteria: ids.map((id) => ({
              criterion_id: id,
              verdict: "pass",
              confidence: "high",
              evidence: [],
              reason: "stub",
            })),
          };
    return {
      output: output as z.infer<S>,
      model: p.model,
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    };
  },
};

const SOURCE = [
  "This Agreement is made on March 3, 2026 between Northwind Ltd. (the Licensor) and the Client.",
  "The Licensor shall keep all Confidential Information secret for 5 years.",
].join("\n\n");
const GLOSSARY =
  "source,target\nAgreement,Contrato\nLicensor,Licenciante\nConfidential Information,Información Confidencial\n";
const translate = (agreementWord: string) =>
  [
    `El presente ${agreementWord} se celebra el 3 de marzo de 2026 entre Northwind Ltd. (el Licenciante) y el Cliente.`,
    "El Licenciante mantendrá en secreto toda la Información Confidencial durante 5 años.",
  ].join("\n\n");

async function job(target: string) {
  const A = h.keys.platformA;
  const agr = (
    await h.call(A, "POST", "/v1/agreements/from-template", {
      buyer_ref: "b",
      seller_ref: "s",
      template: "translation.document",
      params: { source_language: "en", target_language: "es", glossary: true },
      amount: { value: 10_000, currency: "usd" },
      delivery_due_at: "2026-10-20T00:00:00Z",
    })
  ).body;
  expect(agr.spec.criteria.map((c: { id: string }) => c.id)).toContain("glossary-terms");
  const withInputs = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
    inputs: [
      { name: "nda_en.txt", media_type: "text/plain", content: SOURCE },
      { name: "glossary.csv", media_type: "text/csv", content: GLOSSARY },
    ],
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInputs.body.spec_hash,
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [{ name: "nda_es.txt", media_type: "text/plain", content: target }],
  });
  return (await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${agr.id}/verify`)).body;
}

describe("glossary adherence", () => {
  it("releases a translation that uses every approved term", async () => {
    h = await createHarness({
      verifier: (input) => verifyTranslation(input, { caller: allClear }),
    });
    const res = await job(translate("Contrato"));
    expect(res.agreement.outcome).toEqual({ kind: "release" });
    // The glossary isn't mistaken for source text (no omission or paragraph-count findings).
    expect(res.verification.report.findings).toEqual([]);
  });

  it("refunds one that swaps in an unapproved term, even when the model layers see no problem", async () => {
    h = await createHarness({
      verifier: (input) => verifyTranslation(input, { caller: allClear }),
    });
    const res = await job(translate("Acuerdo"));
    expect(res.agreement.outcome).toEqual({ kind: "refund" });
    const glossary = res.verification.report.criteria.find(
      (c: { criterion_id: string }) => c.criterion_id === "glossary-terms",
    );
    expect(glossary.verdict).toBe("fail");
    expect(res.verification.report.findings[0]).toMatchObject({ kind: "glossary_violation" });
  });
});
