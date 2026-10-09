import type { CriterionResult } from "@proofdesk/verifier";
import type { Child } from "hono/jsx";
import type { AgreementRow } from "../services/agreements.ts";

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#2a5bd7;
--ok:#1f7a4d;--ok-bg:#e3f3ea;--bad:#b42318;--bad-bg:#fde8e6;--warn:#9a6700;--warn-bg:#fff4d6;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#a3a29b;--line:#33332f;
--accent:#7ea2ff;--ok:#6fd3a0;--ok-bg:#163526;--bad:#ff9b8f;--bad-bg:#3a1714;--warn:#f2c14e;--warn-bg:#3a2d0b;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
header.top .brand{font-weight:650}header.top nav{display:flex;gap:14px;flex:1}header.top .who{color:var(--muted);font-size:13px}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{color:var(--muted);font-weight:550;font-size:12.5px;text-transform:uppercase;letter-spacing:.02em}
tr:last-child td{border-bottom:none}.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12.5px;background:var(--chip);white-space:nowrap}
.pass,.release{background:var(--ok-bg);color:var(--ok)}.fail,.refund{background:var(--bad-bg);color:var(--bad)}.uncertain,.escalated,.disputed,.partial{background:var(--warn-bg);color:var(--warn)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}
pre.doc{white-space:pre-wrap;word-break:break-word;margin:0;max-height:420px;overflow:auto;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:14px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}.muted{color:var(--muted)}.small{font-size:13px}
.ev{margin:6px 0 0;padding-left:10px;border-left:3px solid var(--line);font-size:13px;color:var(--muted)}
form.inline{display:inline}button,.btn{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}input,select,textarea{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
textarea{width:100%;min-height:80px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;background:var(--ok-bg);color:var(--ok)}
.flash.error{background:var(--bad-bg);color:var(--bad)}.empty{padding:28px;text-align:center;color:var(--muted)}
`;

export function Page(p: {
  title: string;
  session?: {
    accountName: string;
    isOps: boolean;
    mode: "test" | "live";
    csrfToken: string;
  } | null;
  children: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{p.title} · Proof Desk</title>
        <style>{CSS}</style>
      </head>
      <body>
        <header class="top">
          <span class="brand">Proof Desk</span>
          <nav>
            {p.session ? (
              <>
                <a href="/dashboard">Agreements</a>
                {p.session.isOps ? (
                  <>
                    <a href="/dashboard/review">Review queue</a>
                    <a href="/dashboard/reviewers">Reviewers</a>
                  </>
                ) : null}
              </>
            ) : null}
          </nav>
          {p.session ? (
            <span class="who">
              {p.session.accountName} · {p.session.mode}
              <form class="inline" method="post" action="/dashboard/logout">
                <input type="hidden" name="csrf" value={p.session.csrfToken} />{" "}
                <button type="submit" class="small">
                  Sign out
                </button>
              </form>
            </span>
          ) : null}
        </header>
        <main>{p.children}</main>
      </body>
    </html>
  );
}

export function money(value: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "USDC" || code === "USDT") return `${(value / 1e6).toFixed(2)} ${code}`;
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency: code });
    return f.format(value / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${value} ${code}`;
  }
}

export const when = (d: Date | string | null | undefined) =>
  d ? `${new Date(d).toISOString().replace("T", " ").slice(0, 16)} UTC` : "—";

export function Status({ status }: { status: string }) {
  return <span class={`pill ${status}`}>{status.replace("_", " ")}</span>;
}

export function OutcomePill({ outcome }: { outcome: AgreementRow["outcome"] }) {
  if (!outcome) return <span class="muted">—</span>;
  return (
    <span class={`pill ${outcome.kind}`}>
      {outcome.kind === "partial" ? `partial ${outcome.releasePercent}%` : outcome.kind}
    </span>
  );
}

/** Criteria with the verifier's verdict and evidence for each (when there is a report). */
export function Criteria(p: {
  agreement: AgreementRow;
  results?: CriterionResult[];
  showEvidence: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Criterion</th>
          <th>Check</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        {p.agreement.spec.criteria.map((c) => {
          const r = p.results?.find((x) => x.criterion_id === c.id);
          const failing = r?.signals.filter((s) => s.verdict !== "pass") ?? [];
          return (
            <tr>
              <td>
                <div>
                  <span class="mono">{c.id}</span>{" "}
                  {c.critical ? <span class="pill">critical</span> : null}
                </div>
                <div>{c.description}</div>
                {p.showEvidence
                  ? failing.map((s) => (
                      <div class="ev">
                        <strong>{s.source}</strong>: {s.reason}
                        {(s.evidence ?? [])
                          .filter((e) => e.target || e.source)
                          .slice(0, 2)
                          .map((e) => (
                            <div>
                              {e.source ? <span>source “{e.source}” </span> : null}
                              {e.target ? <span>→ delivered “{e.target}”</span> : null}
                            </div>
                          ))}
                      </div>
                    ))
                  : null}
              </td>
              <td class="small muted">{c.check}</td>
              <td>
                {r ? (
                  <span class={`pill ${r.verdict}`}>{r.verdict}</span>
                ) : (
                  <span class="muted">not checked</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Ledger(p: {
  entries: { seq: number; type: string; createdAt: string; entryHash: string; payload: string }[];
  /** Global sequence numbers reveal other agreements' activity; public reports number locally. */
  globalSeq?: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Event</th>
          <th>By</th>
          <th>When</th>
          <th>Entry hash</th>
        </tr>
      </thead>
      <tbody>
        {p.entries.map((e, i) => {
          const actor =
            (JSON.parse(e.payload) as { actor?: { role: string } }).actor?.role ?? "system";
          return (
            <tr>
              <td class="mono">{p.globalSeq === false ? i + 1 : e.seq}</td>
              <td>{e.type.replace("agreement.", "")}</td>
              <td class="small muted">{actor}</td>
              <td class="small">{when(e.createdAt)}</td>
              <td class="mono muted" title={e.entryHash}>
                {e.entryHash.slice(0, 16)}…
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Flash({ ok, error }: { ok?: string | undefined; error?: string | undefined }) {
  if (error) return <div class="flash error">{error}</div>;
  if (ok) return <div class="flash">{ok}</div>;
  return null;
}
