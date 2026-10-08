import { checkOutboundUrl, type SafeResponse, safeRequest } from "@proofdesk/core";

/**
 * Fetching URLs cited in an untrusted deliverable goes through @proofdesk/core's safeRequest:
 * http(s) on standard ports only, every resolved address checked at connect time (no private,
 * loopback, link-local or metadata addresses, no DNS rebinding), redirects re-checked, time and
 * size bounded.
 */

export type FetchResult = SafeResponse;

/** Network layer, injectable so evals and tests run offline with fixtures. */
export type Transport = (url: string) => Promise<FetchResult>;

export { isPublicAddress } from "@proofdesk/core";

/** The real network, with the protections above. */
export const safeTransport: Transport = (url) =>
  safeRequest(url, {
    headers: {
      "User-Agent": "ProofDesk-Verifier/1 (+citation check)",
      Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
    },
  });

/** Same URL checks as safeTransport, in front of a fixture/fake network (evals, tests). */
export function guardedTransport(inner: Transport): Transport {
  return async (raw) => {
    const u = checkOutboundUrl(raw);
    if (typeof u === "string") return { status: "blocked", url: raw, error: u };
    return inner(u.href);
  };
}

/** Readable text of an HTML page (scripts, styles and tags removed, entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .trim();
}
