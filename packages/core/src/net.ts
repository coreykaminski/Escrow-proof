import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Outbound HTTP to URLs we don't control (citations in deliverables, platforms' webhook
 * endpoints) is a server-side request forgery risk: the URL can point at localhost, the cloud
 * metadata service or the internal network. safeRequest only speaks http(s) on standard ports
 * and checks every address a hostname resolves to *at connect time*, so DNS rebinding can't
 * swap in a private address after the check. Redirects are followed by hand and re-checked;
 * time and size are bounded.
 */

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** Loopback, private, link-local, CGNAT, multicast, reserved, and their IPv6 forms are not. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1] as string);
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s)) return false;
    if (s.startsWith("64:ff9b:") || s.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} resolves to a private or reserved address`);
    this.name = "BlockedAddressError";
  }
}

/** dns.lookup that refuses non-public addresses; used as the socket's lookup. */
function guardedLookup(
  hostname: string,
  options: object,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return cb(new BlockedAddressError(hostname), "");
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    const first = list[0] as LookupAddress;
    cb(null, first.address, first.family);
  });
}

/** Why a URL may not be requested, or the parsed URL if it may (before DNS). */
export function checkOutboundUrl(raw: string, opts: { requireHttps?: boolean } = {}): URL | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "https:" && (opts.requireHttps || u.protocol !== "http:")) {
    return opts.requireHttps ? "only https URLs are allowed" : "only http(s) URLs are allowed";
  }
  if (!ALLOWED_PORTS.has(u.port)) return `port ${u.port} isn't allowed`;
  if (u.username || u.password) return "URLs with credentials aren't allowed";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return `${host} is internal`;
  }
  if (isIP(host) && !isPublicAddress(host)) return `${host} is a private or reserved address`;
  return u;
}

export interface SafeResponse {
  status: "ok" | "unreachable" | "blocked";
  http_status?: number;
  url: string;
  content_type?: string;
  body?: string;
  error?: string;
}

export interface SafeRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** POSTs don't follow redirects (a webhook must answer at its URL). */
  maxRedirects?: number;
  requireHttps?: boolean;
}

function once(u: URL, o: SafeRequestOptions): Promise<SafeResponse & { location?: string }> {
  return new Promise((resolve) => {
    const mod = u.protocol === "https:" ? https : http;
    const maxBytes = o.maxBytes ?? 2_000_000;
    const req = mod.request(
      u,
      {
        method: o.method ?? "GET",
        lookup: guardedLookup as never,
        headers: { "Accept-Encoding": "identity", ...o.headers },
        timeout: o.timeoutMs ?? 8_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({
            status: "ok",
            http_status: status,
            url: u.href,
            location: res.headers.location,
          });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) res.destroy();
          else chunks.push(c);
        });
        res.on("close", () =>
          resolve({
            status: status >= 200 && status < 300 ? "ok" : "unreachable",
            http_status: status,
            url: u.href,
            content_type: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) =>
      resolve({
        status: err instanceof BlockedAddressError ? "blocked" : "unreachable",
        url: u.href,
        error: err.message,
      }),
    );
    req.end(o.body);
  });
}

export async function safeRequest(raw: string, o: SafeRequestOptions = {}): Promise<SafeResponse> {
  let current = raw;
  const hops = o.maxRedirects ?? (o.method === "POST" ? 0 : 3);
  for (let hop = 0; hop <= hops; hop++) {
    const u = checkOutboundUrl(current, o.requireHttps ? { requireHttps: true } : {});
    if (typeof u === "string") return { status: "blocked", url: current, error: u };
    const r = await once(u, o);
    if (!r.location) return r;
    if (hop === hops) return { ...r, status: "unreachable", error: "redirected" };
    current = new URL(r.location, u).href;
  }
  return { status: "unreachable", url: current, error: "too many redirects" };
}
