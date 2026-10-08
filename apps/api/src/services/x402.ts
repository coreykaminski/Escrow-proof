import { type authorizationTypedData, networkName } from "@proofdesk/chain";
import { onchainJobJson } from "../serialize.ts";
import type { prepareOnchainJob } from "./onchain.ts";

type Funding = Awaited<ReturnType<typeof prepareOnchainJob>>;

/** Typed data in the shape wallets take for eth_signTypedData_v4 (domain type spelled out). */
export function walletTypedData(td: ReturnType<typeof authorizationTypedData>) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    domain: td.domain,
    message: {
      ...td.message,
      value: td.message.value.toString(),
      validAfter: td.message.validAfter.toString(),
      validBefore: td.message.validBefore.toString(),
    },
  };
}

/** The API's description of how to fund an agreement's on-chain job. */
export function fundingJson(f: Funding) {
  const { config: cfg, terms } = f;
  return {
    object: "onchain_funding",
    chain_id: cfg.chainId,
    network: networkName(cfg.chainId),
    contract: cfg.contract,
    token: cfg.token,
    terms: {
      provider: terms.provider,
      evaluator: terms.evaluator,
      expired_at: Number(terms.expiredAt),
      description: terms.description,
      budget: terms.budget.toString(),
    },
    /** Send these from the buyer's wallet in order, then POST the second tx hash to …/confirm. */
    calls: f.calls,
    /** Or sign this (no gas) and POST the signature to …/authorization. */
    typed_data: f.typedData ? walletTypedData(f.typedData) : null,
    job: onchainJobJson(f.row),
  };
}

export const X402_SCHEME = "erc8183-job";

/**
 * x402 payment requirements for funding the job. The scheme is ERC-8183 job funding: the payer
 * signs an EIP-3009 ReceiveWithAuthorization to the job contract (not a plain transfer), with
 * the nonce derived from the job terms, and the server relays it. Proof Desk never receives
 * the funds.
 */
export function paymentRequired(f: Funding, resource: string, error?: string) {
  const { config: cfg, terms } = f;
  return {
    x402Version: 1,
    error: error ?? "X-PAYMENT header is required",
    accepts: [
      {
        scheme: X402_SCHEME,
        network: networkName(cfg.chainId),
        maxAmountRequired: terms.budget.toString(),
        resource,
        description: f.agreement.spec.title,
        mimeType: "application/json",
        payTo: cfg.contract,
        maxTimeoutSeconds: 600,
        asset: cfg.token,
        extra: {
          authorization: "ReceiveWithAuthorization",
          chainId: cfg.chainId,
          job: {
            provider: terms.provider,
            evaluator: terms.evaluator,
            expiredAt: terms.expiredAt.toString(),
            description: terms.description,
            budget: terms.budget.toString(),
          },
          nonce:
            "keccak256(abi.encode(chainId, payTo, from, provider, evaluator, expiredAt, keccak256(bytes(description)), budget))",
          typedDataUrl: `${resource.replace(/\/x402$/, "")}/onchain/typed-data?client={from}`,
        },
      },
    ],
  };
}

export interface X402Payment {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
  signature: string;
}

/** Decodes an X-PAYMENT header (base64 JSON); null when it's malformed or another scheme. */
export function parsePaymentHeader(header: string): X402Payment | null {
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      scheme?: string;
      payload?: {
        signature?: string;
        authorization?: Record<string, string | number>;
      };
    };
    const a = p.payload?.authorization;
    if (p.scheme !== X402_SCHEME || !a || typeof p.payload?.signature !== "string") return null;
    return {
      from: String(a.from),
      to: String(a.to),
      value: BigInt(a.value ?? -1),
      validAfter: BigInt(a.validAfter ?? 0),
      validBefore: BigInt(a.validBefore ?? 0),
      nonce: String(a.nonce),
      signature: p.payload.signature,
    };
  } catch {
    return null;
  }
}

export function paymentResponseHeader(p: {
  transaction: string | null;
  network: string;
  payer: string;
}) {
  return Buffer.from(JSON.stringify({ success: true, ...p })).toString("base64");
}
