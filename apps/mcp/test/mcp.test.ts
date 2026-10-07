/**
 * MCP end to end (MASTER_PLAN §8 test layer 6): agents drive "hire a translator, pay only if
 * accurate" through the MCP tools, against the real API in-process. The drafting and judging
 * models are stubbed; the deterministic checks and the whole money/state flow are real.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProofDesk } from "@proofdesk/sdk";
import { FakeSpecDrafter } from "@proofdesk/spec-engine";
import { ANNOTATOR_MODEL, type StructuredCaller, verifyTranslation } from "@proofdesk/verifier";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createHarness, type Harness, HOUR } from "../../api/test/harness.ts";
import { createServer, toMinor } from "../src/server.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const SOURCE = [
  "This Services Agreement is entered into on March 3, 2026 between Acme Analytics LLC and the Client.",
  "The Client shall pay a monthly fee of $4,500.00 within 30 days of each invoice.",
].join("\n\n");
const GOOD = [
  "El presente Contrato de Servicios se celebra el 3 de marzo de 2026 entre Acme Analytics LLC y el Cliente.",
  "El Cliente pagará una tarifa mensual de 4.500,00 $ dentro de los 30 días siguientes a cada factura.",
].join("\n\n");

/** Model stub: annotator finds nothing, judge passes every criterion it's shown. */
const passingCaller: StructuredCaller = {
  async call<S extends z.ZodType>(p: { model: string; user: string }) {
    const ids = [...p.user.matchAll(/^- ([a-z0-9-]+)/gm)].map((m) => m[1] as string);
    const output =
      p.model === ANNOTATOR_MODEL
        ? { errors: [], injection_detected: false }
        : {
            criteria: ids.map((criterion_id) => ({
              criterion_id,
              verdict: "pass",
              confidence: "high",
              evidence: [],
              reason: "ok",
            })),
          };
    return {
      output: output as z.infer<S>,
      model: p.model,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  },
};

const translationDraft = new FakeSpecDrafter(() => ({
  title: "Translate services agreement EN→ES",
  vertical: "translation",
  criteria: [
    {
      id: "complete",
      description: "Every sentence is translated; nothing omitted",
      verification: "Align segments",
      check: "domain",
      critical: true,
    },
    {
      id: "values-preserved",
      description: "Every number, amount and date matches the source",
      verification: "Compare values",
      check: "deterministic",
      critical: true,
    },
    {
      id: "meaning-accurate",
      description: "No change in meaning or obligations",
      verification: "Compare clauses",
      check: "domain",
      critical: true,
    },
  ],
  open_questions: ["Which Spanish variant (Spain or Latin America)?"],
}));

async function agent(apiKey: string) {
  const pd = new ProofDesk({ apiKey, baseUrl: "http://proofdesk.test", fetch: h.fetch });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(pd).connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = res.content[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { client, call };
}

async function hireTranslator(deliverable: string) {
  h = await createHarness({
    drafter: translationDraft,
    verifier: (input) => verifyTranslation(input, { caller: passingCaller }),
  });
  const buyer = await agent(h.keys.platformA);
  const seller = await agent(h.keys.platformA);

  const created = await buyer.call("create_protected_purchase", {
    request: "Translate our services agreement into Spanish. Pay only if it's accurate.",
    buyer_ref: "user_42",
    seller_ref: "translator_agent_7",
    amount: 180,
    deliver_by: "2026-10-10T12:00:00Z",
    vertical: "translation",
    source_document: { name: "agreement_en.txt", content: SOURCE },
  });
  expect(created).toMatchObject({
    status: "draft",
    amount: "$180.00",
    open_questions: ["Which Spanish variant (Spain or Latin America)?"],
  });
  expect(created.acceptance_criteria.map((c: { id: string }) => c.id)).toEqual([
    "complete",
    "values-preserved",
    "meaning-accurate",
  ]);
  expect(created.next_step).toContain("approve_purchase_terms");

  const approved = await buyer.call("approve_purchase_terms", {
    agreement_id: created.agreement_id,
    spec_hash: created.spec_hash,
  });
  expect(approved.status).toBe("spec_approved");
  const funded = await buyer.call("fund_purchase", { agreement_id: created.agreement_id });
  expect(funded.status).toBe("funded");

  h.clock.advance(HOUR);
  const delivered = await seller.call("submit_delivery", {
    agreement_id: created.agreement_id,
    files: [{ name: "agreement_es.txt", content: deliverable }],
  });
  expect(delivered.status).toBe("delivered");

  const verified = await buyer.call("sandbox_run_verification", {
    agreement_id: created.agreement_id,
  });
  const status = await buyer.call("get_purchase", { agreement_id: created.agreement_id });
  const settled = await buyer.call("sandbox_settle", { agreement_id: created.agreement_id });
  return { created, verified, status, settled };
}

describe("MCP: hire a translator, pay only if accurate", () => {
  it("pays for an accurate translation", async () => {
    const { status, settled } = await hireTranslator(GOOD);
    expect(status).toMatchObject({
      status: "decided",
      outcome: { kind: "release" },
      verification: { result: "release" },
    });
    expect(settled).toMatchObject({
      status: "settled",
      next_step: expect.stringContaining("Settled"),
    });
  });

  it("refunds a translation that changed the amount", async () => {
    const { status } = await hireTranslator(GOOD.replace("4.500,00", "5.400,00"));
    expect(status).toMatchObject({
      status: "decided",
      outcome: { kind: "refund" },
      verification: { result: "refund" },
    });
    expect(status.verification.criteria).toContain("values-preserved: fail");
  });

  it("returns readable tool errors instead of failing the protocol", async () => {
    h = await createHarness({ drafter: translationDraft });
    const buyer = await agent(h.keys.platformA);
    await expect(buyer.call("get_purchase", { agreement_id: "agr_missing" })).rejects.toThrow(
      /not_found/,
    );
  });

  it("offers sandbox tools only with test keys", async () => {
    h = await createHarness();
    const names = async (key: string) =>
      (await (await agent(key)).client.listTools()).tools.map((t) => t.name);
    expect(await names(h.keys.platformA)).toContain("sandbox_settle");
    expect(await names(h.keys.live)).not.toContain("sandbox_settle");
    expect(await names(h.keys.live)).toContain("create_protected_purchase");
  });
});

describe("toMinor", () => {
  it.each([
    [180, "usd", 18_000],
    [19.99, "eur", 1_999],
    [1500, "jpy", 1_500],
    [2.5, "usdc", 2_500_000],
  ])("%d %s → %d", (amount, currency, minor) => {
    expect(toMinor(amount, currency)).toBe(minor);
  });
});
