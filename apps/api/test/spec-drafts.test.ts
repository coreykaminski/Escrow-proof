import { type DraftOutput, FakeSpecDrafter, SpecDraftError } from "@proofdesk/spec-engine";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, specFixture } from "./harness.ts";

let h: Harness;

afterEach(async () => {
  await h?.close();
});

const fromRequest = {
  buyer_ref: "user_buyer_1",
  seller_ref: "agent_translator_7",
  request: "Translate the attached NDA into Spanish (Spain), legal register.",
  amount: { value: 18_000, currency: "usd" },
  delivery_due_at: "2026-10-10T12:00:00Z",
};

const intentMandate = {
  natural_language_description: "Translate my 12-page lease into French by Friday",
  user_cart_confirmation_required: true,
  intent_expiry: "2026-10-07T12:00:00Z",
};

const cartMandate = {
  contents: {
    id: "cart_42",
    payment_request: {
      details: { total: { label: "Total", amount: { currency: "USD", value: 179.99 } } },
    },
    cart_expiry: "2026-10-06T18:00:00Z",
    merchant_name: "LinguaBot",
  },
};

const fake = () => h.drafter as FakeSpecDrafter;

describe("POST /v1/agreements/from-request", () => {
  it("drafts criteria into a draft agreement the buyer can edit and approve", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const res = await h.call(A, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "draft",
      amount: { value: 18_000, currency: "usd" },
      delivery_due_at: "2026-10-10T12:00:00.000Z",
      spec: { request: fromRequest.request, vertical: "general", appeal_window_hours: 72 },
      spec_source: {
        kind: "drafted",
        model: "fake-drafter",
        prompt_version: "spec-drafter/1",
        open_questions: [],
      },
    });
    expect(res.body.spec.criteria.map((c: { id: string }) => c.id)).toEqual(["complete", "format"]);
    expect(fake().calls).toEqual([{ request: fromRequest.request, vertical: undefined }]);

    // Buyer edits a criterion, which changes the hash and marks the draft edited…
    const spec = { ...res.body.spec, criteria: res.body.spec.criteria.slice(0, 1) };
    const edited = await h.call(A, "PUT", `/v1/agreements/${res.body.id}/spec`, { spec });
    expect(edited.status).toBe(200);
    expect(edited.body.spec_hash).not.toBe(res.body.spec_hash);
    expect(edited.body.spec_source).toMatchObject({ kind: "drafted", edited: true });

    // …and approves the version they saw.
    const approved = await h.call(A, "POST", `/v1/agreements/${res.body.id}/approve-spec`, {
      spec_hash: edited.body.spec_hash,
    });
    expect(approved.body.status).toBe("spec_approved");

    const ledger = await h.call(A, "GET", `/v1/agreements/${res.body.id}/ledger`);
    expect(ledger.body.data[0].payload.spec_source).toEqual({
      kind: "drafted",
      model: "fake-drafter",
      prompt_version: "spec-drafter/1",
    });
  });

  it("passes the caller's vertical to the drafter and keeps the caller's title", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", {
      ...fromRequest,
      vertical: "translation",
      title: "NDA EN→ES",
    });
    expect(res.body.spec).toMatchObject({ vertical: "translation", title: "NDA EN→ES" });
    expect(fake().calls[0]?.vertical).toBe("translation");
  });

  it("never takes money terms from the model", async () => {
    // A drafter can't return amounts at all; the spec's terms are the caller's.
    h = await createHarness({
      drafter: new FakeSpecDrafter(
        () =>
          ({
            title: "Pay me",
            vertical: "general",
            criteria: [
              {
                id: "x",
                description: "Every requested file is delivered",
                verification: "Count files",
                check: "deterministic",
                critical: true,
              },
            ],
            open_questions: [],
            // Extra keys from a misbehaving model are dropped by spec validation.
            amount: { value: 1, currency: "usd" },
          }) as DraftOutput,
      ),
    });
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.body.amount).toEqual({ value: 18_000, currency: "usd" });
    expect(res.body.spec).not.toHaveProperty("open_questions");
  });

  it("returns lint warnings for vague criteria", async () => {
    h = await createHarness({
      drafter: new FakeSpecDrafter(() => ({
        title: "Blog post",
        vertical: "general",
        criteria: [
          {
            id: "quality",
            description: "The writing is high quality and engaging",
            verification: "",
            check: "judge",
            critical: false,
          },
        ],
        open_questions: ["Who is the audience?"],
      })),
    });
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.status).toBe(201);
    const codes = res.body.spec_warnings.map((w: { code: string }) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "vague_wording",
        "no_verification",
        "single_criterion",
        "no_critical_criterion",
      ]),
    );
    expect(res.body.spec_source.open_questions).toEqual(["Who is the audience?"]);
  });

  it("validates terms before spending a model call", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", {
      ...fromRequest,
      amount: { value: -5, currency: "usd" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(fake().calls).toHaveLength(0);
  });

  it("replays an idempotent retry without drafting twice", async () => {
    h = await createHarness();
    const headers = { "Idempotency-Key": "draft-1" };
    const A = h.keys.platformA;
    const first = await h.call(A, "POST", "/v1/agreements/from-request", fromRequest, headers);
    const again = await h.call(A, "POST", "/v1/agreements/from-request", fromRequest, headers);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    expect(fake().calls).toHaveLength(1);
  });

  it("returns 503 when no drafter is configured", async () => {
    h = await createHarness({ drafter: undefined });
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("spec_engine_unavailable");
  });

  it.each([
    ["refused", 422, "spec_draft_refused"],
    ["unavailable", 503, "spec_engine_unavailable"],
    ["failed", 502, "spec_draft_failed"],
    ["invalid_draft", 502, "spec_draft_invalid"],
  ] as const)("maps a %s draft error to %i %s", async (code, status, apiCode) => {
    h = await createHarness();
    fake().failNext = new SpecDraftError(code, "boom");
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(apiCode);
    const list = await h.call(h.keys.platformA, "GET", "/v1/agreements");
    expect(list.body.data).toHaveLength(0);
  });

  it("lets a retry succeed after a transient failure under the same idempotency key", async () => {
    h = await createHarness();
    const headers = { "Idempotency-Key": "draft-retry" };
    const A = h.keys.platformA;
    fake().failNext = new SpecDraftError("unavailable", "overloaded");
    const first = await h.call(A, "POST", "/v1/agreements/from-request", fromRequest, headers);
    expect(first.status).toBe(503);
    const retry = await h.call(A, "POST", "/v1/agreements/from-request", fromRequest, headers);
    expect(retry.status).toBe(201);
  });

  it("requires the platform scope", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.ops, "POST", "/v1/agreements/from-request", fromRequest);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/agreements/from-mandate", () => {
  const base = {
    buyer_ref: "user_buyer_1",
    seller_ref: "agent_translator_7",
    delivery_due_at: "2026-10-10T12:00:00Z",
  };

  it("drafts from an intent mandate, with the caller's amount", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "intent",
      mandate: intentMandate,
      amount: { value: 9_000, currency: "usd" },
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toEqual({ value: 9_000, currency: "usd" });
    expect(res.body.spec.request).toContain("Translate my 12-page lease into French");
    expect(res.body.spec_source.mandate).toEqual({
      type: "intent",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      signature_verified: false,
    });
    const ledger = await h.call(h.keys.platformA, "GET", `/v1/agreements/${res.body.id}/ledger`);
    expect(ledger.body.data[0].payload.spec_source.mandate.type).toBe("intent");
  });

  it("requires an amount for an intent mandate", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "intent",
      mandate: intentMandate,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("amount_required");
    expect(fake().calls).toHaveLength(0);
  });

  it("takes the price from a cart mandate and rejects a conflicting amount", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    const ok = await h.call(A, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "cart",
      mandate: cartMandate,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toEqual({ value: 17_999, currency: "usd" });

    const restated = await h.call(A, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "cart",
      mandate: cartMandate,
      amount: { value: 17_999, currency: "usd" },
    });
    expect(restated.status).toBe(201);

    const conflict = await h.call(A, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "cart",
      mandate: cartMandate,
      amount: { value: 100, currency: "usd" },
    });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.code).toBe("amount_mismatch");
  });

  it("rejects expired and malformed mandates", async () => {
    h = await createHarness();
    const A = h.keys.platformA;
    h.clock.advance(48 * 3_600_000);
    const expired = await h.call(A, "POST", "/v1/agreements/from-mandate", {
      ...base,
      delivery_due_at: "2026-10-12T12:00:00Z",
      mandate_type: "intent",
      mandate: intentMandate,
      amount: { value: 9_000, currency: "usd" },
    });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe("mandate_expired");

    const malformed = await h.call(A, "POST", "/v1/agreements/from-mandate", {
      ...base,
      mandate_type: "cart",
      mandate: intentMandate,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_mandate");
    expect(fake().calls).toHaveLength(0);
  });
});

describe("existing agreements", () => {
  it("report a manual spec source and lint warnings", async () => {
    h = await createHarness();
    const res = await h.call(h.keys.platformA, "POST", "/v1/agreements", {
      buyer_ref: "b",
      seller_ref: "s",
      spec: specFixture(),
    });
    expect(res.body.spec_source).toEqual({ kind: "manual" });
    expect(res.body.spec_warnings).toEqual([
      expect.objectContaining({ code: "no_verification", criterion_id: "no-omissions" }),
      expect.objectContaining({ code: "no_verification", criterion_id: "register" }),
    ]);
  });
});
