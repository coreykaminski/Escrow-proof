import { networkName } from "@proofdesk/chain";
import { PRICING } from "@proofdesk/core";
import { type AppDeps, verifiersOf } from "../env.ts";

/**
 * Machine-readable listing for ERC-8183 ecosystems and agent marketplaces: who the evaluator
 * is, which jobs it takes, what it costs and how to hire it. Served at
 * /.well-known/erc8183-evaluator.json; null when the stablecoin rail isn't configured.
 */
export async function evaluatorListing(deps: AppDeps) {
  if (!deps.chain) return null;
  const cfg = await deps.chain.config();
  const verifiers = verifiersOf(deps);
  const base = deps.publicUrl ?? "";
  return {
    object: "erc8183_evaluator",
    name: "Proof Desk",
    description:
      "Neutral evaluator for ERC-8183 jobs: checks the delivery against acceptance criteria agreed before funding (deterministic checks, domain verifiers, model judges, human review on escalation and appeal), then calls complete or reject. Every step is written to a hash-chained ledger anchored on-chain.",
    evaluator: cfg.evaluator,
    chain_id: cfg.chainId,
    network: networkName(cfg.chainId),
    mode: cfg.mode,
    token: cfg.token,
    native_contract: cfg.contract,
    verticals: (Object.keys(verifiers) as (keyof typeof verifiers)[]).filter((v) => verifiers[v]),
    outcomes: ["complete", "reject"],
    hooks_supported: false,
    pricing_usd_cents: {
      verification: PRICING.verification,
      dispute: PRICING.dispute,
    },
    how_to_hire: [
      "Create an agreement with the acceptance criteria and approve it: POST /v1/agreements, then POST /v1/agreements/{id}/approve-spec.",
      "Read the job terms: GET /v1/agreements/{id}/external-job/terms (the evaluator, budget, minimum expiry, and the text the job description must contain).",
      "Create and fund the job on any ERC-8183 contract with those terms, then attach it: POST /v1/agreements/{id}/external-job.",
      "The provider delivers to Proof Desk (POST /v1/agreements/{id}/deliveries) and calls submit() on the job contract.",
    ],
    links: {
      api: `${base}/docs`,
      agent_card: `${base}/.well-known/agent-card.json`,
      openapi: `${base}/openapi.json`,
      accuracy: `${base}/accuracy.json`,
      status: `${base}/status.json`,
    },
  };
}
