import type { WebhookEvent } from "./types.ts";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verifies a Proof Desk webhook and returns the event. Pass the raw request body (exactly as
 * received), the `Proofdesk-Signature` header and your endpoint's secret. Rejects signatures older
 * than `toleranceSeconds` to block replays. Uses Web Crypto, so it runs in Node 18+, Deno, Bun
 * and edge runtimes.
 */
export async function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  opts: { toleranceSeconds?: number; now?: Date } = {},
): Promise<WebhookEvent> {
  const parts = new Map<string, string[]>();
  for (const item of signatureHeader.split(",")) {
    const [k, v] = item.split("=", 2);
    if (k && v) parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  const signatures = parts.get("v1") ?? [];
  if (!Number.isFinite(t) || signatures.length === 0) {
    throw new WebhookVerificationError("malformed Proofdesk-Signature header");
  }
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError("signature timestamp is outside the tolerance window");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)),
  );
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!signatures.some((s) => timingSafeEqual(s, expected))) {
    throw new WebhookVerificationError("signature doesn't match");
  }
  return JSON.parse(rawBody) as WebhookEvent;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
