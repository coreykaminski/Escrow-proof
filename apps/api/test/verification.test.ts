import {
  ANNOTATOR_MODEL,
  type Annotation,
  type Judgment,
  ModelCallError,
  type StructuredCaller,
  verifyTranslation,
} from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { TranslationVerifier } from "../src/services/verification.ts";
import { createHarness, type Harness, HOUR, specFixture } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const SOURCE = [
  "This Services Agreement is entered into on March 3, 2026 between Acme Analytics LLC and the Client.",
  "The Client shall pay a monthly fee of $4,500.00 within 30 days of each invoice.",
  "Either party may terminate this Agreement with 60 days' written notice.",
].join("\n\n");

const GOOD = [
  "El presente Contrato de Servicios se celebra el 3 de marzo de 2026 entre Acme Analytics LLC y el Cliente.",
  "El Cliente pagará una tarifa mensual de 4.500,00 $ dentro de los 30 días siguientes a cada factura.",
  "Cualquiera de las partes podrá rescindir este Contrato con un preaviso por escrito de 60 días.",
].join("\n\n");

/** Real verifier, stubbed model: the annotator and judge say what each test needs. */
function verifierWith(opts: { judgeFails?: string; error?: Error } = {}) {
  let calls = 0;
  const caller: StructuredCaller = {
    async call<S extends z.ZodType>(p: { model: string; user: string }) {
      calls++;
      if (opts.error) throw opts.error;
      const ids = [...p.user.matchAll(/^- ([a-z0-9-]+)/gm)].map((m) => m[1] as string);
      const output: Annotation | Judgment =
        p.model === ANNOTATOR_MODEL
          ? { errors: [], injection_detected: false }
          : {
              criteria: ids.map((id) => ({
                criterion_id: id,
                verdict: id === opts.judgeFails ? "fail" : "pass",
                confidence: "high",
                evidence:
                  id === opts.judgeFails
                    ? [{ source_quote: "may terminate", target_quote: "podrá" }]
                    : [],
                reason: "stub",
              })),
            };
      return {
        output: output as z.infer<S>,
        model: p.model,
        usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
      };
    },
  };
  const verifier: TranslationVerifier = (input) => verifyTranslation(input, { caller });
  return { verifier, calls: () => calls };
}

const translationSpec = () =>
  specFixture({
    criteria: [
      { id: "complete", description: "Nothing omitted", check: "domain", critical: true },
      {
        id: "values-preserved",
        description: "Every number and date matches",
        check: "deterministic",
        critical: true,
      },
      {
        id: "meaning-accurate",
        description: "No change in meaning",
        check: "domain",
        critical: true,
      },
    ],
  });

async function delivered(target = GOOD, spec: Record<string, unknown> = translationSpec()) {
  const A = h.keys.platformA;
  const agr = (await h.call(A, "POST", "/v1/agreements", { buyer_ref: "b", seller_ref: "s", spec }))
    .body;
  const withInputs = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
    inputs: [{ name: "contract_en.txt", media_type: "text/plain", content: SOURCE }],
  });
  expect(withInputs.status).toBe(200);
  await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, {
    spec_hash: withInputs.body.spec_hash,
  });
  await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h1" });
  h.clock.advance(HOUR);
  const d = await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
    artifacts: [{ name: "contrato_es.txt", media_type: "text/plain", content: target }],
  });
  expect(d.status).toBe(201);
  return agr.id as string;
}

const verify = (id: string) => h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/verify`);

describe("inputs", () => {
  it("locks source files into the spec hash and the ledger", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: translationSpec(),
      })
    ).body;
    const res = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
      inputs: [{ name: "contract_en.txt", media_type: "text/plain", content: SOURCE }],
    });
    expect(res.body.spec.inputs).toEqual([
      {
        name: "contract_en.txt",
        media_type: "text/plain",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(res.body.spec_hash).not.toBe(agr.spec_hash);

    const list = await h.call(A, "GET", `/v1/agreements/${agr.id}/inputs`);
    expect(list.body.data[0]).not.toHaveProperty("content");
    const full = await h.call(A, "GET", `/v1/agreements/${agr.id}/inputs?include_content=true`);
    expect(full.body.data[0].content).toBe(SOURCE);

    const ledger = await h.call(A, "GET", `/v1/agreements/${agr.id}/ledger`);
    expect(ledger.body.data.at(-1)).toMatchObject({
      type: "agreement.inputs_replaced",
      payload: { spec_hash: res.body.spec_hash, inputs: res.body.spec.inputs },
    });
  });

  it("ignores inputs a caller writes into the spec itself", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const bogus = [{ name: "fake.txt", media_type: "text/plain", sha256: "0".repeat(64) }];
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: { ...translationSpec(), inputs: bogus },
      })
    ).body;
    expect(agr.spec).not.toHaveProperty("inputs");
    const withInputs = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
      inputs: [{ name: "real.txt", media_type: "text/plain", content: SOURCE }],
    });
    const replaced = await h.call(A, "PUT", `/v1/agreements/${agr.id}/spec`, {
      spec: { ...withInputs.body.spec, inputs: bogus, title: "Edited" },
    });
    expect(replaced.body.spec.inputs).toEqual(withInputs.body.spec.inputs);
  });

  it("can't change after approval, and rejects duplicate names", async () => {
    h = await createHarness();
    const id = await delivered();
    const late = await h.call(h.keys.platformA, "PUT", `/v1/agreements/${id}/inputs`, {
      inputs: [],
    });
    expect(late.status).toBe(409);
    const A = h.keys.platformA;
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: translationSpec(),
      })
    ).body;
    const dup = await h.call(A, "PUT", `/v1/agreements/${agr.id}/inputs`, {
      inputs: [
        { name: "a.txt", media_type: "text/plain", content: "x" },
        { name: "a.txt", media_type: "text/plain", content: "y" },
      ],
    });
    expect(dup.body.error.code).toBe("duplicate_input_name");
  });
});

describe("POST /v1/ops/agreements/:id/verify", () => {
  it("releases a faithful translation automatically and records the report", async () => {
    const v = verifierWith();
    h = await createHarness({ verifier: v.verifier });
    const id = await delivered();
    const res = await verify(id);
    expect(res.status).toBe(200);
    expect(res.body.agreement).toMatchObject({ status: "decided", outcome: { kind: "release" } });
    expect(res.body.verification).toMatchObject({
      object: "verification",
      action: "decide",
      outcome: { kind: "release" },
      engine_version: expect.stringMatching(/^translation-v1\//),
      report_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(v.calls()).toBe(2);

    const A = h.keys.platformA;
    const list = await h.call(A, "GET", `/v1/agreements/${id}/verifications`);
    expect(list.body.data[0].report.decision.outcome).toEqual({ kind: "release" });

    const ledger = await h.call(A, "GET", `/v1/agreements/${id}/ledger`);
    const types = ledger.body.data.map((e: { type: string }) => e.type);
    expect(types.slice(-3)).toEqual([
      "agreement.start_verification",
      "agreement.verification_recorded",
      "agreement.decide",
    ]);
    expect(ledger.body.data.at(-1).payload).toMatchObject({
      decided_by: "auto",
      actor: { role: "system" },
    });
    expect(ledger.body.data.at(-2).payload.report_hash).toBe(res.body.verification.report_hash);
    const chain = await h.call(h.keys.ops, "GET", "/v1/ops/ledger/verify");
    expect(chain.body.ok).toBe(true);
  });

  it("refunds a changed amount without calling the models", async () => {
    const v = verifierWith();
    h = await createHarness({ verifier: v.verifier });
    const id = await delivered(GOOD.replace("4.500,00", "4.050,00"));
    const res = await verify(id);
    expect(res.body.agreement).toMatchObject({ status: "decided", outcome: { kind: "refund" } });
    expect(v.calls()).toBe(0);
  });

  it("escalates when the model layers disagree, and a human can then decide", async () => {
    h = await createHarness({
      verifier: verifierWith({ judgeFails: "meaning-accurate" }).verifier,
    });
    const id = await delivered();
    const res = await verify(id);
    expect(res.body.agreement.status).toBe("escalated");
    expect(res.body.verification.action).toBe("escalate");
    const human = await h.call(h.keys.ops, "POST", `/v1/ops/agreements/${id}/decide`, {
      outcome: { kind: "release" },
      reason: "reviewed: faithful",
    });
    expect(human.body.status).toBe("decided");
  });

  it("stays in verifying when the model is unavailable, so ops can retry", async () => {
    h = await createHarness({
      verifier: verifierWith({ error: new ModelCallError("unavailable", "overloaded") }).verifier,
    });
    const id = await delivered();
    const res = await verify(id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("verifier_unavailable");
    const agr = await h.call(h.keys.ops, "GET", `/v1/ops/agreements/${id}`);
    expect(agr.body.status).toBe("verifying");
    const list = await h.call(h.keys.platformA, "GET", `/v1/agreements/${id}/verifications`);
    expect(list.body.data).toEqual([]);
  });

  it("explains what's missing instead of guessing", async () => {
    h = await createHarness({ verifier: verifierWith().verifier });
    const A = h.keys.platformA;
    // Not a translation job.
    const general = await delivered(GOOD, { ...translationSpec(), vertical: "general" });
    expect((await verify(general)).body.error.code).toBe("no_automated_verifier");
    // Not delivered yet.
    const agr = (
      await h.call(A, "POST", "/v1/agreements", {
        buyer_ref: "b",
        seller_ref: "s",
        spec: translationSpec(),
      })
    ).body;
    expect((await verify(agr.id)).status).toBe(409);
    // No source attached.
    await h.call(A, "POST", `/v1/agreements/${agr.id}/approve-spec`, { spec_hash: agr.spec_hash });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/fund`, { rail: "test", hold_ref: "h" });
    await h.call(A, "POST", `/v1/agreements/${agr.id}/deliveries`, {
      artifacts: [{ name: "x.txt", media_type: "text/plain", content: GOOD }],
    });
    expect((await verify(agr.id)).body.error.code).toBe("missing_source");
  });

  it("returns 503 without a verifier and keeps platform keys out", async () => {
    h = await createHarness();
    const id = await delivered();
    expect((await verify(id)).body.error.code).toBe("verifier_unavailable");
    const asPlatform = await h.call(h.keys.platformA, "POST", `/v1/ops/agreements/${id}/verify`);
    expect(asPlatform.status).toBe(403);
  });
});
