/** Response shapes returned by the Proof Desk API (v1). Amounts are integer minor units. */

export type AgreementStatus =
  | "draft"
  | "spec_approved"
  | "funded"
  | "delivered"
  | "verifying"
  | "escalated"
  | "decided"
  | "disputed"
  | "settled"
  | "cancelled";

export type Outcome =
  | { kind: "release" }
  | { kind: "refund" }
  | { kind: "partial"; release_percent: number };

export interface Criterion {
  id: string;
  description: string;
  verification?: string;
  check: "deterministic" | "domain" | "judge";
  critical: boolean;
}

export interface Spec {
  version: 1;
  title: string;
  request: string;
  vertical: "translation" | "code" | "data" | "general";
  criteria: Criterion[];
  amount: { value: number; currency: string };
  delivery_due_at: string;
  appeal_window_hours: number;
  inputs?: { name: string; media_type: string; sha256: string }[];
}

/** What you send: like Spec, with defaults optional. */
export type SpecInput = Omit<Spec, "appeal_window_hours" | "criteria" | "inputs"> & {
  appeal_window_hours?: number;
  criteria: (Omit<Criterion, "critical"> & { critical?: boolean })[];
};

export interface SpecWarning {
  code: string;
  message: string;
  criterion_id?: string;
}

export interface Agreement {
  id: string;
  object: "agreement";
  livemode: boolean;
  status: AgreementStatus;
  buyer_ref: string;
  seller_ref: string;
  spec: Spec;
  spec_hash: string;
  spec_source: Record<string, unknown> | null;
  spec_warnings: SpecWarning[];
  spec_approved_at: string | null;
  amount: { value: number; currency: string };
  delivery_due_at: string;
  hold: { rail: string; ref: string; funded_at: string | null } | null;
  outcome: Outcome | null;
  decided_at: string | null;
  appeal_window_hours: number;
  appeal_window_ends_at: string | null;
  dispute_resolved: boolean;
  /** Shadow mode (pilots): an automatic decision waiting for a human review before it settles. */
  review_pending: boolean;
  settled_at: string | null;
  settlement_ref: string | null;
  cancelled_at: string | null;
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  name: string;
  media_type: string;
  content: string;
}

export interface Delivery {
  id: string;
  object: "delivery";
  agreement_id: string;
  manifest_hash: string;
  submitted_at: string;
  artifacts: { name: string; media_type: string; sha256: string; content?: string }[];
}

export interface Hold {
  id: string;
  object: "hold";
  agreement_id: string;
  rail: "card";
  payment_intent_id: string;
  status: "pending" | "authorized" | "captured" | "settled" | "canceled" | "expired";
  amount: { value: number; currency: string };
  captured_amount: number;
  capture_before: string | null;
  extended_authorization: boolean;
  disputed: boolean;
  settlement: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntry {
  seq: number;
  type: string;
  agreement_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  prev_hash: string;
  entry_hash: string;
}

export interface Verification {
  id: string;
  object: "verification";
  agreement_id: string;
  delivery_id: string;
  engine_version: string;
  action: "decide" | "escalate";
  outcome: Outcome | null;
  confidence: number;
  report_hash: string;
  report: Record<string, unknown>;
  created_at: string;
}

export interface Seller {
  id: string;
  object: "seller";
  seller_ref: string;
  stripe_account_id: string;
  details_submitted: boolean;
  payouts_ready: boolean;
  payouts_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SellerWallet {
  id: string;
  object: "seller_wallet";
  seller_ref: string;
  address: string;
  created_at: string;
  updated_at: string;
}

/** An ERC-8183 job on the ProofDeskJobs contract holding the agreement's USDC. */
export interface OnchainJob {
  id: string;
  object: "onchain_job";
  agreement_id: string;
  chain_id: number;
  contract: string;
  job_id: string | null;
  status: "awaiting_funding" | "funded" | "settled" | "expired";
  client: string | null;
  provider: string;
  evaluator: string;
  description: string;
  budget: { value: number; currency: "usdc" };
  expires_at: string;
  fund_tx: string | null;
  settle_tx: string | null;
  settlement: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** EIP-712 typed data for eth_signTypedData_v4 (amounts as decimal strings). */
export interface WalletTypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "ReceiveWithAuthorization";
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

export interface OnchainFunding {
  object: "onchain_funding";
  chain_id: number;
  network: string;
  contract: string;
  token: string;
  terms: {
    provider: string;
    evaluator: string;
    expired_at: number;
    description: string;
    budget: string;
  };
  /** Send in order from the buyer's wallet, then confirm with the second transaction's hash. */
  calls: { to: string; data: string; description: string }[];
  /** Present when `client` was given: sign it for gasless funding. */
  typed_data: WalletTypedData | null;
  job: OnchainJob;
}

export interface WebhookEndpoint {
  id: string;
  object: "webhook_endpoint";
  url: string;
  event_types: string[];
  enabled: boolean;
  failure_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  /** Only present in the response that created the endpoint. */
  secret?: string;
}

export interface WebhookEvent {
  id: string;
  object: "event";
  type: string;
  created_at: string;
  agreement_id: string | null;
  data: Record<string, unknown>;
  ledger: { seq: number; entry_hash: string };
}

export interface List<T> {
  object: "list";
  data: T[];
}
