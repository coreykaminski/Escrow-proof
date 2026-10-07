import type {
  Agreement,
  AgreementStatus,
  Artifact,
  Delivery,
  Hold,
  LedgerEntry,
  List,
  Outcome,
  Seller,
  SpecInput,
  Verification,
  WebhookEndpoint,
} from "./types.ts";

export interface ProofDeskOptions {
  /** A `pd_test_…` or `pd_live_…` key. */
  apiKey: string;
  baseUrl?: string;
  /** Retries for network errors, 5xx and 429 (same idempotency key each time). Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class ProofDeskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProofDeskError";
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Terms {
  buyer_ref: string;
  seller_ref: string;
  delivery_due_at: string;
  title?: string;
  vertical?: SpecInput["vertical"];
  appeal_window_hours?: number;
  metadata?: Record<string, string>;
}

/**
 * Proof Desk API client. Every POST/PUT gets an Idempotency-Key (yours, or a generated one) that
 * is reused across retries, so a retried call can never act twice.
 */
export class ProofDesk {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ProofDeskOptions) {
    if (!/^pd_(test|live)_/.test(opts.apiKey))
      throw new Error("apiKey must start with pd_test_ or pd_live_");
    this.baseUrl = (opts.baseUrl ?? "http://localhost:8787").replace(/\/$/, "");
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get livemode(): boolean {
    return this.opts.apiKey.startsWith("pd_live_");
  }

  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const key =
      method === "POST" || method === "PUT" ? (idempotencyKey ?? crypto.randomUUID()) : undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await delay(attempt);
          continue;
        }
        throw new ProofDeskError(
          0,
          "network_error",
          err instanceof Error ? err.message : String(err),
        );
      }
      const text = await res.text();
      const json = parseJson(text);
      if (res.ok) return json as T;
      const retryable =
        res.status >= 500 ||
        res.status === 429 ||
        json?.error?.code === "idempotency_request_in_progress";
      if (retryable && attempt < this.maxRetries) {
        await delay(attempt);
        continue;
      }
      const e = json?.error ?? {};
      throw new ProofDeskError(
        res.status,
        e.code ?? "http_error",
        e.message ?? `HTTP ${res.status}`,
        e.details,
      );
    }
  }

  readonly agreements = {
    /** Create a draft with a spec you wrote. */
    create: (
      p: {
        buyer_ref: string;
        seller_ref: string;
        spec: SpecInput;
        metadata?: Record<string, string>;
      },
      opts?: RequestOpts,
    ) => this.request<Agreement>("POST", "/v1/agreements", p, opts?.idempotencyKey),
    /** Create a draft whose acceptance criteria Proof Desk drafts from a plain-language request. */
    createFromRequest: (
      p: Terms & { request: string; amount: { value: number; currency: string } },
      opts?: RequestOpts,
    ) => this.request<Agreement>("POST", "/v1/agreements/from-request", p, opts?.idempotencyKey),
    /** Same, from an AP2 intent or cart mandate. */
    createFromMandate: (
      p: Terms & {
        mandate_type: "intent" | "cart";
        mandate: Record<string, unknown>;
        amount?: { value: number; currency: string };
      },
      opts?: RequestOpts,
    ) => this.request<Agreement>("POST", "/v1/agreements/from-mandate", p, opts?.idempotencyKey),
    retrieve: (id: string) => this.request<Agreement>("GET", `/v1/agreements/${enc(id)}`),
    list: (p: { status?: AgreementStatus; limit?: number } = {}) =>
      this.request<List<Agreement>>("GET", `/v1/agreements${query(p)}`),
    replaceSpec: (id: string, spec: SpecInput) =>
      this.request<Agreement>("PUT", `/v1/agreements/${enc(id)}/spec`, { spec }),
    /** Attach the source material (e.g. the document to translate). Draft only. */
    replaceInputs: (id: string, inputs: Artifact[]) =>
      this.request<Agreement>("PUT", `/v1/agreements/${enc(id)}/inputs`, { inputs }),
    listInputs: (id: string, p: { includeContent?: boolean } = {}) =>
      this.request<List<Artifact & { id: string; sha256: string }>>(
        "GET",
        `/v1/agreements/${enc(id)}/inputs${p.includeContent ? "?include_content=true" : ""}`,
      ),
    /** The buyer approves exactly the spec they saw, identified by its hash. */
    approveSpec: (id: string, specHash: string) =>
      this.request<Agreement>("POST", `/v1/agreements/${enc(id)}/approve-spec`, {
        spec_hash: specHash,
      }),
    cancel: (id: string, p: { actor: "buyer" | "seller"; reason: string }) =>
      this.request<Agreement>("POST", `/v1/agreements/${enc(id)}/cancel`, p),
    /** Test rail funding (sandbox). Use createCardHold for real cards. */
    fund: (id: string, p: { rail: "test"; hold_ref: string }) =>
      this.request<Agreement>("POST", `/v1/agreements/${enc(id)}/fund`, p),
    /** Authorize the buyer's card. Confirm on the client with client_secret, or pass payment_method. */
    createCardHold: (id: string, p: { payment_method?: string } = {}) =>
      this.request<{
        hold: Hold;
        payment_intent_status: string;
        client_secret: string | null;
        agreement: Agreement;
      }>("POST", `/v1/agreements/${enc(id)}/card-hold`, p),
    retrieveHold: (id: string) => this.request<Hold>("GET", `/v1/agreements/${enc(id)}/hold`),
    deliver: (id: string, artifacts: Artifact[]) =>
      this.request<{ delivery_id: string; manifest_hash: string; agreement: Agreement }>(
        "POST",
        `/v1/agreements/${enc(id)}/deliveries`,
        { artifacts },
      ),
    listDeliveries: (id: string, p: { includeContent?: boolean } = {}) =>
      this.request<List<Delivery>>(
        "GET",
        `/v1/agreements/${enc(id)}/deliveries${p.includeContent ? "?include_content=true" : ""}`,
      ),
    openDispute: (id: string, p: { opened_by: "buyer" | "seller"; reason: string }) =>
      this.request<Agreement>("POST", `/v1/agreements/${enc(id)}/disputes`, p),
    ledger: (id: string) =>
      this.request<List<LedgerEntry>>("GET", `/v1/agreements/${enc(id)}/ledger`),
    verifications: (id: string) =>
      this.request<List<Verification>>("GET", `/v1/agreements/${enc(id)}/verifications`),
  };

  readonly sellers = {
    /** Create the seller's payout account (first call) and get a hosted onboarding link. */
    startOnboarding: (sellerRef: string, p: { return_url?: string; refresh_url?: string } = {}) =>
      this.request<{ seller: Seller; onboarding_url: string }>(
        "POST",
        `/v1/sellers/${enc(sellerRef)}/onboarding`,
        p,
      ),
    retrieve: (sellerRef: string) => this.request<Seller>("GET", `/v1/sellers/${enc(sellerRef)}`),
  };

  readonly webhookEndpoints = {
    /** The response includes the signing `secret`, shown only once. */
    create: (p: { url: string; event_types?: string[] }) =>
      this.request<WebhookEndpoint>("POST", "/v1/webhook-endpoints", p),
    list: () => this.request<List<WebhookEndpoint>>("GET", "/v1/webhook-endpoints"),
    delete: (id: string) =>
      this.request<{ deleted: true }>("DELETE", `/v1/webhook-endpoints/${enc(id)}`),
    attempts: (id: string) =>
      this.request<
        List<{
          event_id: string;
          status_code: number | null;
          error: string | null;
          created_at: string;
        }>
      >("GET", `/v1/webhook-endpoints/${enc(id)}/attempts`),
  };

  /** Sandbox only (pd_test_ keys): drive an agreement without Proof Desk ops. */
  readonly testHelpers = {
    decide: (id: string, outcome: Outcome, reason?: string) =>
      this.request<Agreement>("POST", `/v1/test_helpers/agreements/${enc(id)}/decide`, {
        outcome,
        ...(reason ? { reason } : {}),
      }),
    verify: (id: string) =>
      this.request<{ agreement: Agreement; verification: Verification | null }>(
        "POST",
        `/v1/test_helpers/agreements/${enc(id)}/verify`,
      ),
    settle: (id: string) =>
      this.request<Agreement>("POST", `/v1/test_helpers/agreements/${enc(id)}/settle`),
  };
}

export interface RequestOpts {
  idempotencyKey?: string;
}

const enc = encodeURIComponent;

/** Error pages from proxies and load balancers aren't JSON; don't let them mask the status. */
// biome-ignore lint/suspicious/noExplicitAny: API responses are typed by the caller
function parseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function query(p: Record<string, string | number | undefined>): string {
  const entries = Object.entries(p).filter(([, v]) => v !== undefined) as [
    string,
    string | number,
  ][];
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : "";
}

function delay(attempt: number) {
  return new Promise((r) => setTimeout(r, Math.min(2_000, 200 * 2 ** attempt)));
}
