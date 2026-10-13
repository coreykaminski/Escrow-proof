/**
 * The embeddable verdict widget: a platform shows Proof Desk's verdict inside its own pages.
 *
 *   <script src="https://<proof desk>/embed/v1.js" async></script>
 *   <div data-proofdesk-verdict="<report link token or URL>" data-theme="auto"></div>
 *
 * The loader swaps each such element for an iframe of /embed/r/:token, a compact read-only
 * view keyed by the same unguessable, expiring token as the full report, and sizes the iframe
 * to its content. Only these pages may be framed; every other page keeps frame-ancestors 'none'.
 */
import type { AnyReport } from "@proofdesk/verifier";
import { Hono } from "hono";
import type { AppDeps } from "../env.ts";
import { lastAnchor } from "../services/anchoring.ts";
import { loadCaseFile } from "../services/case-file.ts";
import { resolveShareLink } from "../services/share-links.ts";

/** CSP for embed pages: framable anywhere, nothing else loosened. */
export const EMBED_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors *",
].join("; ");

const STYLE = `
:root{--bg:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#2a5bd7;--ok:#1f7a4d;--ok-bg:#e3f3ea;
--bad:#b42318;--bad-bg:#fde8e6;--warn:#9a6700;--warn-bg:#fff4d6;--chip:#efeee9}
:root.dark{--bg:#1d1d1b;--text:#ecebe6;--muted:#a3a29b;--line:#33332f;--accent:#7ea2ff;--ok:#6fd3a0;--ok-bg:#163526;
--bad:#ff9b8f;--bad-bg:#3a1714;--warn:#f2c14e;--warn-bg:#3a2d0b;--chip:#2a2a27}
@media (prefers-color-scheme:dark){:root.auto{--bg:#1d1d1b;--text:#ecebe6;--muted:#a3a29b;--line:#33332f;--accent:#7ea2ff;
--ok:#6fd3a0;--ok-bg:#163526;--bad:#ff9b8f;--bad-bg:#3a1714;--warn:#f2c14e;--warn-bg:#3a2d0b;--chip:#2a2a27}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.title{font-weight:600;font-size:15px}.muted{color:var(--muted)}.small{font-size:12.5px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12.5px;font-weight:600;background:var(--chip)}
.release,.pass{background:var(--ok-bg);color:var(--ok)}.refund,.fail{background:var(--bad-bg);color:var(--bad)}
.partial,.uncertain,.pending{background:var(--warn-bg);color:var(--warn)}
ul{list-style:none;margin:10px 0 0;padding:0}li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)}
li .pill{flex:none;min-width:56px;text-align:center}
.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
`;

type Theme = "light" | "dark" | "auto";

function EmbedPage(p: { theme: Theme; children: unknown }) {
  return (
    <html lang="en" class={p.theme}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>Proof Desk verdict</title>
        <style>{STYLE}</style>
      </head>
      <body>
        {p.children}
        <script src="/embed/frame.js" />
      </body>
    </html>
  );
}

const STATUS_TEXT: Record<string, string> = {
  release: "Passed",
  refund: "Failed",
  partial: "Partly passed",
};

export function embedRoutes(deps: AppDeps) {
  const { db, now } = deps;
  const r = new Hono();

  r.get("/v1.js", (c) =>
    c.body(LOADER_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Cross-Origin-Resource-Policy": "cross-origin",
    }),
  );
  r.get("/frame.js", (c) =>
    c.body(FRAME_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  );

  r.get("/r/:token", async (c) => {
    const theme =
      (["light", "dark", "auto"] as const).find((t) => t === c.req.query("theme")) ?? "auto";
    c.header("Content-Security-Policy", EMBED_CSP);
    const id = await resolveShareLink(db, c.req.param("token"), "report", now());
    if (!id) {
      return c.html(
        <EmbedPage theme={theme}>
          <div class="card muted">This verdict link has expired or doesn't exist.</div>
        </EmbedPage>,
        404,
      );
    }
    const file = await loadCaseFile(db, id, {});
    const a = file.agreement;
    const report = file.verification?.report as AnyReport | undefined;
    const anchor = await lastAnchor(db);
    const anchored = anchor && (file.ledger.at(-1)?.seq ?? Number.POSITIVE_INFINITY) <= anchor.seq;
    const outcome = a.outcome;
    const decision = file.decisions.at(-1);
    const fullReport = `/r/${c.req.param("token")}`;
    return c.html(
      <EmbedPage theme={theme}>
        <div class="card">
          <div class="head">
            <span class="title">{a.spec.title}</span>
            {outcome ? (
              <span class={`pill ${outcome.kind}`}>
                {outcome.kind === "partial"
                  ? `${STATUS_TEXT.partial}: ${outcome.releasePercent}% paid`
                  : STATUS_TEXT[outcome.kind]}
              </span>
            ) : (
              <span class="pill pending">
                {a.status === "escalated" || a.status === "disputed"
                  ? "Being reviewed"
                  : "Not decided yet"}
              </span>
            )}
          </div>
          {decision ? (
            <div class="small muted" style="margin-top:4px">
              {decision.decidedBy === "auto"
                ? "Checked automatically"
                : "Decided by a human reviewer"}
              {a.decidedAt ? ` · ${a.decidedAt.toISOString().slice(0, 10)}` : ""}
            </div>
          ) : null}
          <ul>
            {a.spec.criteria.map((cr) => {
              const v = report?.criteria.find((x) => x.criterion_id === cr.id)?.verdict;
              return (
                <li>
                  <span class={`pill ${v ?? "pending"}`}>{v ?? "pending"}</span>
                  <span>{cr.description}</span>
                </li>
              );
            })}
          </ul>
          <div class="foot small">
            <span class="muted">
              Verified by Proof Desk{anchored ? " · record anchored on-chain" : ""}
            </span>
            <a href={fullReport} target="_blank" rel="noopener">
              Full report and proof ↗
            </a>
          </div>
        </div>
      </EmbedPage>,
    );
  });

  return r;
}

/** Runs inside the embed page: tells the host page how tall the widget is. */
const FRAME_JS = `(function(){
  var token = location.pathname.split("/").pop();
  function send(){
    var h = document.documentElement.scrollHeight;
    parent.postMessage({ type: "proofdesk:height", token: token, height: h }, "*");
  }
  send();
  if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
  else window.addEventListener("load", send);
})();`;

/** On the host page: replaces [data-proofdesk-verdict] elements with sized iframes. */
const LOADER_JS = `(function(){
  var script = document.currentScript;
  var origin = new URL(script ? script.src : location.href).origin;
  var frames = {};
  function tokenOf(v){
    v = (v || "").trim();
    var m = v.match(/\\/r\\/([A-Za-z0-9_-]{20,64})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
  }
  function mount(el){
    if (el.getAttribute("data-proofdesk-mounted")) return;
    var token = tokenOf(el.getAttribute("data-proofdesk-verdict"));
    if (!token) return;
    var theme = el.getAttribute("data-theme") || "auto";
    var f = document.createElement("iframe");
    f.src = origin + "/embed/r/" + token + "?theme=" + encodeURIComponent(theme);
    f.title = "Proof Desk verdict";
    f.loading = "lazy";
    f.setAttribute("referrerpolicy", "no-referrer");
    f.style.cssText = "border:0;width:100%;height:160px;display:block;color-scheme:normal";
    el.setAttribute("data-proofdesk-mounted", "1");
    el.appendChild(f);
    frames[token] = f;
  }
  window.addEventListener("message", function(e){
    if (e.origin !== origin || !e.data || e.data.type !== "proofdesk:height") return;
    var f = frames[e.data.token];
    if (f && typeof e.data.height === "number") f.style.height = Math.min(e.data.height, 4000) + "px";
  });
  function scan(){ document.querySelectorAll("[data-proofdesk-verdict]").forEach(mount); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
  window.ProofDesk = window.ProofDesk || {};
  window.ProofDesk.mountVerdicts = scan;
})();`;
