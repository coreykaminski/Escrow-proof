import type { CodeReport, DataReport } from "@proofdesk/verifier";
import type { GOLDEN_RESULTS } from "../services/accuracy.ts";
import type { AgreementRow } from "../services/agreements.ts";
import type { CaseFile, reviewerStats, reviewQueue } from "../services/case-file.ts";
import { Criteria, Flash, Ledger, money, OutcomePill, Page, Status, when } from "./ui.tsx";

export interface Viewer {
  accountName: string;
  isOps: boolean;
  mode: "test" | "live";
  csrfToken: string;
}

export function LoginPage(p: { error?: string }) {
  return (
    <Page title="Sign in">
      <div class="panel" style="max-width:440px;margin:40px auto">
        <h1>Sign in</h1>
        <p class="sub">Use a Proof Desk API key. Ops keys open the review queue.</p>
        <Flash error={p.error} />
        <form method="post" action="/dashboard/login">
          <input
            type="password"
            name="api_key"
            placeholder="pd_test_…"
            autocomplete="off"
            required
            style="width:100%;margin-bottom:12px"
          />
          <button class="primary" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </Page>
  );
}

export function AgreementsPage(p: { viewer: Viewer; rows: AgreementRow[]; status?: string }) {
  const statuses = [
    "draft",
    "spec_approved",
    "funded",
    "delivered",
    "verifying",
    "escalated",
    "decided",
    "disputed",
    "settled",
    "cancelled",
  ];
  return (
    <Page title="Agreements" session={p.viewer}>
      <h1>Agreements</h1>
      <p class="sub">{p.viewer.isOps ? "All accounts" : p.viewer.accountName}</p>
      <form method="get" class="row" style="margin-bottom:12px">
        <select name="status">
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option value={s} selected={s === p.status}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
        <button type="submit">Filter</button>
      </form>
      {p.rows.length === 0 ? (
        <div class="panel empty">No agreements yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agreement</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Outcome</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((a) => (
              <tr>
                <td>
                  <a href={`/dashboard/agreements/${a.id}`}>{a.spec.title}</a>
                  <div class="mono muted">{a.id}</div>
                </td>
                <td>
                  <Status status={a.status} />
                </td>
                <td>{money(a.amountValue, a.currency)}</td>
                <td>
                  <OutcomePill outcome={a.outcome} />
                </td>
                <td class="small">{when(a.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

export function QueuePage(p: {
  viewer: Viewer;
  items: Awaited<ReturnType<typeof reviewQueue>>;
  now: Date;
}) {
  return (
    <Page title="Review queue" session={p.viewer}>
      <h1>Review queue</h1>
      <p class="sub">
        Escalated by the verifier, disputed by a party, or held for a shadow review (pilot
        accounts). Oldest first.
      </p>
      {p.items.length === 0 ? (
        <div class="panel empty">Nothing waiting for review.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Why</th>
              <th>Amount</th>
              <th>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((i) => (
              <tr>
                <td>
                  <a href={`/dashboard/agreements/${i.agreement.id}`}>{i.agreement.spec.title}</a>{" "}
                  <Status status={i.agreement.status} />
                  <div class="mono muted">{i.agreement.id}</div>
                </td>
                <td class="small">{i.reason}</td>
                <td>{money(i.agreement.amountValue, i.agreement.currency)}</td>
                <td class="small">{hoursSince(i.waitingSince, p.now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

function hoursSince(d: Date, now: Date) {
  const h = Math.floor((now.getTime() - d.getTime()) / 3_600_000);
  return h < 1 ? "<1 h" : h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

export function CasePage(p: {
  viewer: Viewer;
  file: CaseFile;
  flash?: { ok?: string; error?: string };
  shareUrl?: string;
}) {
  const { agreement: a, verification: v } = p.file;
  const needsReview = p.viewer.isOps && a.status === "decided" && a.reviewPending;
  const needsDecision =
    needsReview || (p.viewer.isOps && (a.status === "escalated" || a.status === "disputed"));
  const openDispute = p.file.disputes.find((d) => d.status === "open");
  return (
    <Page title={a.spec.title} session={p.viewer}>
      <Flash ok={p.flash?.ok} error={p.flash?.error} />
      <h1>{a.spec.title}</h1>
      <p class="sub">
        <span class="mono">{a.id}</span> · <Status status={a.status} /> ·{" "}
        {money(a.amountValue, a.currency)} · {a.livemode ? "live" : "test"}
      </p>

      <div class="grid2">
        <div class="panel">
          <dl class="kv">
            <dt>Buyer</dt>
            <dd>{a.buyerRef}</dd>
            <dt>Seller</dt>
            <dd>{a.sellerRef}</dd>
            <dt>Deliver by</dt>
            <dd>{when(a.deliveryDueAt)}</dd>
            <dt>Outcome</dt>
            <dd>
              <OutcomePill outcome={a.outcome} />
            </dd>
            <dt>Appeal window</dt>
            <dd>
              {p.file.appealEndsAt
                ? `until ${when(p.file.appealEndsAt)}`
                : `${a.appealWindowHours} h after decision`}
            </dd>
            <dt>Funding</dt>
            <dd>
              {p.file.hold
                ? `card hold · ${p.file.hold.status}${p.file.hold.captureBefore ? ` · capture by ${when(p.file.hold.captureBefore)}` : ""}`
                : a.holdRail === "none"
                  ? "verification only (no payment)"
                  : (a.holdRail ?? "not funded")}
            </dd>
          </dl>
        </div>
        <div class="panel">
          <dl class="kv">
            <dt>Spec hash</dt>
            <dd class="mono">{a.specHash.slice(0, 24)}…</dd>
            <dt>Delivery</dt>
            <dd class="mono">
              {p.file.delivery ? `${p.file.delivery.manifestHash.slice(0, 24)}…` : "—"}
            </dd>
            <dt>Verifier</dt>
            <dd>
              {v
                ? `${v.action === "decide" ? (v.outcome?.kind ?? "") : "escalated"} · ${Math.round(v.confidence * 100)}% · ${v.engineVersion}`
                : "not run"}
            </dd>
            <dt>Decision reason</dt>
            <dd class="small">
              {p.file.decisions.at(-1)?.reason ?? v?.report.decision.reason ?? "—"}
            </dd>
          </dl>
          <form
            method="post"
            action={`/dashboard/agreements/${a.id}/report-link`}
            style="margin-top:12px"
          >
            <input type="hidden" name="csrf" value={p.viewer.csrfToken} />
            <button type="submit">Create shareable verdict link</button>
          </form>
          {p.shareUrl ? (
            <p class="small">
              Share link (valid 30 days): <a href={p.shareUrl}>{p.shareUrl}</a>
            </p>
          ) : null}
        </div>
      </div>

      {openDispute ? (
        <>
          <h2>Dispute</h2>
          <div class="panel">
            Opened by <strong>{openDispute.openedBy}</strong> on {when(openDispute.openedAt)}:{" "}
            {openDispute.reason}
          </div>
        </>
      ) : null}

      {needsDecision ? (
        <>
          <h2>
            {needsReview
              ? "Shadow review"
              : a.status === "disputed"
                ? "Resolve the dispute (final)"
                : "Decide"}
          </h2>
          {needsReview ? (
            <form class="panel" method="post" action={`/dashboard/agreements/${a.id}/decision`}>
              <input type="hidden" name="csrf" value={p.viewer.csrfToken} />
              <input type="hidden" name="outcome" value="confirm" />
              <p class="small">
                The verifier decided <OutcomePill outcome={a.outcome} /> automatically. Nothing
                settles until a reviewer confirms it or records a different outcome below.
              </p>
              <input
                name="reason"
                required
                placeholder="Why you agree (recorded on the ledger)"
                style="width:100%"
              />
              <div style="margin-top:10px">
                <button class="primary" type="submit">
                  Confirm the automatic decision
                </button>
              </div>
            </form>
          ) : null}
          <form class="panel" method="post" action={`/dashboard/agreements/${a.id}/decision`}>
            <input type="hidden" name="csrf" value={p.viewer.csrfToken} />
            <div class="row" style="margin-bottom:10px">
              <label>
                <input type="radio" name="outcome" value="release" required /> Release to seller
              </label>
              <label>
                <input type="radio" name="outcome" value="refund" /> Refund buyer
              </label>
              <label>
                <input type="radio" name="outcome" value="partial" /> Partial:
              </label>
              <input
                type="number"
                name="release_percent"
                min="1"
                max="99"
                placeholder="% to seller"
                style="width:120px"
              />
            </div>
            <textarea
              name="reason"
              required
              placeholder="Reason, citing the criteria (recorded on the ledger and shown to both parties)"
            />
            <div style="margin-top:10px">
              <button class="primary" type="submit">
                {needsReview ? "Override with this outcome" : "Record decision"}
              </button>
            </div>
          </form>
        </>
      ) : null}

      <h2>Acceptance criteria</h2>
      <Criteria agreement={a} results={v?.report.criteria} showEvidence={true} />

      {v?.report.findings.length ? (
        <>
          <h2>Automated findings</h2>
          <table>
            <tbody>
              {v.report.findings.map((f) => (
                <tr>
                  <td>
                    <span class={`pill ${f.confidence === "high" ? "fail" : "uncertain"}`}>
                      {f.kind.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td class="small">{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {v && "vertical" in v.report && v.report.vertical === "code" ? (
        <TestRun tests={v.report.tests} />
      ) : null}
      {v && "vertical" in v.report && v.report.vertical === "data" ? (
        <Sources data={v.report.data} />
      ) : null}

      <h2>Documents</h2>
      <div class="grid2">
        <div class="panel">
          <div class="muted small" style="margin-bottom:6px">
            Source ({p.file.inputs.map((i) => i.name).join(", ") || "none attached"})
          </div>
          <pre class="doc">{p.file.inputs.map((i) => i.content).join("\n\n") || "—"}</pre>
        </div>
        <div class="panel">
          <div class="muted small" style="margin-bottom:6px">
            Delivered ({p.file.delivery?.artifacts.map((x) => x.name).join(", ") || "nothing yet"})
          </div>
          <pre class="doc">
            {p.file.delivery?.artifacts.map((x) => x.content).join("\n\n") || "—"}
          </pre>
        </div>
      </div>

      <h2>Ledger</h2>
      <Ledger entries={p.file.ledger} />
    </Page>
  );
}

export function ReviewersPage(p: {
  viewer: Viewer;
  rows: Awaited<ReturnType<typeof reviewerStats>>;
  days: number;
}) {
  return (
    <Page title="Reviewers" session={p.viewer}>
      <h1>Reviewers</h1>
      <p class="sub">
        Human decisions in the last {p.days} days, per reviewer key. The basis for reviewer payouts.
      </p>
      {p.rows.length === 0 ? (
        <div class="panel empty">No human decisions yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Reviewer</th>
              <th>Decisions</th>
              <th>Of which disputes</th>
              <th>Last decision</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr>
                <td>
                  {r.reviewer}
                  <div class="mono muted">{r.apiKeyId}</div>
                </td>
                <td>{r.decisions}</td>
                <td>{r.disputeResolutions}</td>
                <td class="small">{when(r.lastDecisionAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

/** Public, shareable: verdicts and proof, but not the documents themselves. */
export function ReportPage(p: {
  file: CaseFile;
  ledgerOk: boolean;
  anchor?: { seq: number; tx_hash: string; chain_id: number; contract: string; at: Date } | null;
}) {
  const { agreement: a, verification: v } = p.file;
  const decision = p.file.decisions.at(-1);
  return (
    <Page title={`Verdict: ${a.spec.title}`}>
      <h1>{a.spec.title}</h1>
      <p class="sub">
        Verdict report · <Status status={a.status} /> · {money(a.amountValue, a.currency)}
      </p>
      <div class="panel">
        <dl class="kv">
          <dt>Outcome</dt>
          <dd>
            <OutcomePill outcome={a.outcome} />
          </dd>
          <dt>Decided</dt>
          <dd>
            {when(a.decidedAt)}
            {decision
              ? ` · by ${decision.decidedBy === "auto" ? "automated verification" : "a human reviewer"}`
              : ""}
          </dd>
          <dt>Reason</dt>
          <dd>{decision?.reason ?? v?.report.decision.reason ?? "—"}</dd>
          <dt>Appeal window</dt>
          <dd>{p.file.appealEndsAt ? `until ${when(p.file.appealEndsAt)}` : "—"}</dd>
          <dt>Approved spec</dt>
          <dd class="mono">{a.specHash}</dd>
          <dt>Delivery</dt>
          <dd class="mono">{p.file.delivery?.manifestHash ?? "—"}</dd>
          {v ? (
            <>
              <dt>Verification</dt>
              <dd class="mono">
                {v.engineVersion} · report {v.reportHash}
              </dd>
            </>
          ) : null}
          <dt>Ledger</dt>
          <dd>
            {p.ledgerOk ? (
              <span class="pill pass">hash chain intact</span>
            ) : (
              <span class="pill fail">chain check failed</span>
            )}
          </dd>
          {p.anchor && (p.file.ledger.at(-1)?.seq ?? Number.POSITIVE_INFINITY) <= p.anchor.seq ? (
            <>
              <dt>Anchored on-chain</dt>
              <dd class="small">
                Ledger head #{p.anchor.seq} posted {when(p.anchor.at)} on chain {p.anchor.chain_id}{" "}
                to <span class="mono">{p.anchor.contract}</span> (tx{" "}
                <span class="mono">{p.anchor.tx_hash.slice(0, 18)}…</span>). Every entry above is
                covered.
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      <h2>Criteria</h2>
      <Criteria agreement={a} results={v?.report.criteria} showEvidence={true} />
      <h2>Ledger entries</h2>
      <Ledger entries={p.file.ledger} />
      <p class="small muted" style="margin-top:16px">
        Each entry's hash covers the previous one, so any edit to the history breaks the chain.
        Hashes let either party prove which spec was approved and which files were delivered without
        revealing them.
      </p>
    </Page>
  );
}

export function PayPage(p: {
  agreement: AgreementRow;
  clientSecret: string | null;
  publishableKey: string | undefined;
  status: string;
  returnUrl: string;
}) {
  const a = p.agreement;
  const ready = p.clientSecret && p.publishableKey && p.status === "requires_payment_method";
  return (
    <Page title="Authorize payment">
      <div class="panel" style="max-width:520px;margin:24px auto">
        <h1>{money(a.amountValue, a.currency)}</h1>
        <p class="sub">{a.spec.title}</p>
        <p class="small">
          Your card is <strong>authorized, not charged</strong>. It's only charged if the delivered
          work passes the agreed checks; otherwise the hold is released.
        </p>
        {ready ? (
          <>
            <div
              id="pay"
              data-pk={p.publishableKey}
              data-secret={p.clientSecret ?? ""}
              data-return={p.returnUrl}
            />
            <div id="payment-element" style="margin:16px 0" />
            <button id="submit" class="primary" type="button">
              Authorize {money(a.amountValue, a.currency)}
            </button>
            <p id="message" class="small" style="color:var(--bad)" />
            <script src="https://js.stripe.com/v3/" />
            <script src="/pay/assets/pay.js" />
          </>
        ) : (
          <p class="flash">
            {p.status === "requires_capture" || p.status === "succeeded"
              ? "Payment authorized. You can close this page."
              : !p.publishableKey
                ? "Card entry isn't configured on this server yet."
                : `This payment can't be completed here (status: ${p.status}).`}
          </p>
        )}
      </div>
    </Page>
  );
}

/** Client script for the hosted card page (served as a file; reads values from data attributes). */
export const PAY_JS = `(() => {
  const el = document.getElementById("pay");
  if (!el || !window.Stripe) return;
  const stripe = Stripe(el.dataset.pk);
  const elements = stripe.elements({ clientSecret: el.dataset.secret });
  elements.create("payment").mount("#payment-element");
  const button = document.getElementById("submit");
  button.addEventListener("click", async () => {
    button.disabled = true;
    const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: el.dataset.return } });
    if (error) {
      document.getElementById("message").textContent = error.message;
      button.disabled = false;
    }
  });
})();`;

/** Hosted USDC page: the buyer signs one gasless authorization in their wallet (or sends the calls). */
export function OnchainPayPage(p: {
  agreement: AgreementRow;
  token: string;
  job: {
    status: string;
    chainId: number;
    network: string;
    contract: string;
    asset: string;
    provider: string;
    expiresAt: Date;
    fundTx: string | null;
  };
  calls: { to: string; data: string; description: string }[];
}) {
  const a = p.agreement;
  const awaiting = p.job.status === "awaiting_funding" && a.status === "spec_approved";
  return (
    <Page title="Fund in USDC">
      <div class="panel" style="max-width:620px;margin:24px auto">
        <h1>{money(a.amountValue, a.currency)}</h1>
        <p class="sub">{a.spec.title}</p>
        <p class="small">
          The USDC is locked in a public job contract on {p.job.network}, not sent to Proof Desk or
          the seller. It's paid to the seller only if the delivered work passes the agreed checks;
          otherwise it comes back to you. If nobody decides by {when(p.job.expiresAt)}, you can
          reclaim it from the contract yourself.
        </p>
        {awaiting ? (
          <>
            <div id="onchain" data-token={p.token} data-chain={String(p.job.chainId)} />
            <button id="sign" class="primary" type="button">
              Connect wallet and authorize (no gas)
            </button>
            <p id="message" class="small" />
            <details style="margin-top:16px">
              <summary class="small">Or send the transactions yourself</summary>
              <ol class="small">
                {p.calls.map((call) => (
                  <li>
                    {call.description}: to <span class="mono">{call.to}</span>
                    <pre class="doc mono" style="max-height:120px">
                      {call.data}
                    </pre>
                  </li>
                ))}
              </ol>
              <p class="small">Then paste the second transaction's hash:</p>
              <div class="row">
                <input id="txhash" placeholder="0x…" style="flex:1" />
                <button id="confirm" type="button">
                  Confirm
                </button>
              </div>
            </details>
            <script src="/pay/assets/onchain.js" />
          </>
        ) : (
          <p class="flash">
            {p.job.status === "funded" || p.job.fundTx
              ? "Funded. You can close this page."
              : `This payment can't be completed here (status: ${a.status}).`}
          </p>
        )}
        <dl class="kv" style="margin-top:16px">
          <dt>Job contract</dt>
          <dd class="mono">{p.job.contract}</dd>
          <dt>Token</dt>
          <dd class="mono">{p.job.asset}</dd>
          <dt>Seller receives at</dt>
          <dd class="mono">{p.job.provider}</dd>
        </dl>
      </div>
    </Page>
  );
}

/** Client script for the hosted USDC page: EIP-1193 wallet, EIP-712 signature, relay. */
export const ONCHAIN_JS = `(() => {
  const el = document.getElementById("onchain");
  if (!el) return;
  const base = "/pay/" + el.dataset.token;
  const msg = document.getElementById("message");
  const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--bad)" : "var(--ok)"; };
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || "request failed");
    return json;
  };
  const sign = document.getElementById("sign");
  sign.addEventListener("click", async () => {
    if (!window.ethereum) return say("No browser wallet found. Use the manual option below.", true);
    sign.disabled = true;
    try {
      const [from] = await window.ethereum.request({ method: "eth_requestAccounts" });
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + Number(el.dataset.chain).toString(16) }] }).catch(() => {});
      const res = await fetch(base + "/onchain/typed-data?client=" + from);
      const td = await res.json();
      if (!res.ok) throw new Error((td.error && td.error.message) || "could not load the authorization");
      say("Check your wallet to sign…");
      const signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(td)] });
      say("Submitting…");
      await post("/onchain/authorize", { client: from, valid_after: td.message.validAfter, valid_before: td.message.validBefore, signature });
      location.reload();
    } catch (e) {
      say(e.message || String(e), true);
      sign.disabled = false;
    }
  });
  const confirm = document.getElementById("confirm");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await post("/onchain/confirm", { tx_hash: document.getElementById("txhash").value.trim() });
      location.reload();
    } catch (e) {
      say(e.message || String(e), true);
      confirm.disabled = false;
    }
  });
})();`;

function TestRun({ tests }: { tests: CodeReport["tests"] }) {
  return (
    <>
      <h2>Test run</h2>
      <p class="small muted">
        {tests.passed} passed · {tests.failed} failed · {tests.runtime} in the {tests.sandbox}{" "}
        sandbox · {(tests.duration_ms / 1000).toFixed(1)} s{tests.timed_out ? " · timed out" : ""}
      </p>
      <table>
        <tbody>
          {tests.cases.map((t) => (
            <tr>
              <td>
                <span
                  class={`pill ${t.status === "pass" ? "pass" : t.status === "fail" ? "fail" : ""}`}
                >
                  {t.status}
                </span>
              </td>
              <td class="small">
                {t.name}
                {t.message ? <div class="ev">{t.message}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Sources({ data }: { data: DataReport["data"] }) {
  if (data.citations.length === 0 && data.schema_errors.length === 0) return null;
  return (
    <>
      {data.schema_errors.length ? (
        <>
          <h2>Schema errors</h2>
          <table>
            <tbody>
              {data.schema_errors.slice(0, 20).map((e) => (
                <tr>
                  <td class="mono small">{e.path}</td>
                  <td class="small">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {data.citations.length ? (
        <>
          <h2>Cited sources</h2>
          <table>
            <tbody>
              {data.citations.map((c) => (
                <tr>
                  <td>
                    <span class={`pill ${c.status === "ok" ? "pass" : "fail"}`}>{c.status}</span>
                  </td>
                  <td class="small mono">{c.url}</td>
                  <td class="small muted">
                    {data.quotes
                      .filter((q) => q.url === c.url)
                      .map((q) => `${q.found ? "✓" : "✗"} “${q.quote.slice(0, 80)}”`)
                      .join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

const HEALTH_LABEL = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  not_configured: "Not enabled",
} as const;

export function StatusPage(p: {
  status: keyof typeof HEALTH_LABEL;
  components: { name: string; status: keyof typeof HEALTH_LABEL; detail: string }[];
  checkedAt: Date;
}) {
  const pill = (s: keyof typeof HEALTH_LABEL) =>
    s === "operational" ? "pass" : s === "degraded" ? "uncertain" : s === "down" ? "fail" : "";
  return (
    <Page title="Status">
      <h1>
        Proof Desk status: <span class={`pill ${pill(p.status)}`}>{HEALTH_LABEL[p.status]}</span>
      </h1>
      <p class="sub">Checked {when(p.checkedAt)}. Machine-readable at /status.json.</p>
      <table>
        <tbody>
          {p.components.map((c) => (
            <tr>
              <td>{c.name}</td>
              <td>
                <span class={`pill ${pill(c.status)}`}>{HEALTH_LABEL[c.status]}</span>
              </td>
              <td class="small muted">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

export function PricingPage(p: {
  pricing: {
    conditionalPayment: { rate: number; minCents: number; capCents: number };
    verification: { translation: number; code: number; data: number; research: number };
    dispute: { minCents: number; rate: number };
    verifyOnlyMonthlyMinimumCents: number;
    directHoldMaxCents: number;
  };
}) {
  const { conditionalPayment: cp, verification: v, dispute: d } = p.pricing;
  return (
    <Page title="Pricing">
      <h1>Pricing</h1>
      <p class="sub">
        Pay only when the work is done right. Funds stay with the card network or in a public
        contract until the delivery passes the checks both sides agreed to.
      </p>
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th>Price</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Conditional payment</td>
            <td>{cp.rate * 100}% of the released amount</td>
            <td class="small muted">
              Min {usd(cp.minCents)}, max {usd(cp.capCents)} per job. Nothing on refunds. Volume
              tiers down to 1%.
            </td>
          </tr>
          <tr>
            <td>Verification: structured data</td>
            <td>{usd(v.data)} per check</td>
            <td class="small muted">Schema, record counts, duplicates.</td>
          </tr>
          <tr>
            <td>Verification: translation</td>
            <td>{usd(v.translation)} per check</td>
            <td class="small muted">
              Numbers, dates, omissions and meaning, with quoted evidence.
            </td>
          </tr>
          <tr>
            <td>Verification: research</td>
            <td>{usd(v.research)} per check</td>
            <td class="small muted">Every cited source loads; every quote is verbatim.</td>
          </tr>
          <tr>
            <td>Verification: code</td>
            <td>{usd(v.code)} per check</td>
            <td class="small muted">Your tests, run in an isolated sandbox.</td>
          </tr>
          <tr>
            <td>Human dispute review</td>
            <td>
              {usd(d.minCents)} or {d.rate * 100}%, whichever is higher
            </td>
            <td class="small muted">Charged for the losing side. The decision is final.</td>
          </tr>
          <tr>
            <td>Verify API only (no payments)</td>
            <td>Verification fees, {usd(p.pricing.verifyOnlyMonthlyMinimumCents)}/month minimum</td>
            <td class="small muted">For checking agent output without moving money.</td>
          </tr>
        </tbody>
      </table>
      <p class="small muted" style="margin-top:16px">
        Card processing and network fees are passed through at cost. Verification and dispute fees
        are invoiced monthly; test mode is free. Enterprise: custom verifiers, SLA, private ledger
        export.
      </p>
      <p class="small muted">
        Payments are held for jobs up to {usd(p.pricing.directHoldMaxCents)}. Larger jobs can use
        verification only for now.
      </p>
    </Page>
  );
}

type GoldenSuite = (typeof GOLDEN_RESULTS)["suites"][number];

const GOLDEN_METRICS = [
  ["false_release", "Paid for bad work (false release)"],
  ["false_refund", "Refused good work (false refund)"],
  ["critical_recall", "Critical errors caught"],
  ["adversarial", "Attacks never paid out"],
  ["escalation_honest", "Honest work sent to a human"],
] as const;

function GoldenSuitePanel(p: { suite: GoldenSuite }) {
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
  return (
    <div class="panel" style="margin-bottom:12px">
      <h3 style="margin-top:0">{p.suite.name}</h3>
      {p.suite.runs.length === 0 ? (
        <p class="small muted">{p.suite.note}</p>
      ) : (
        p.suite.runs.map((r) => (
          <>
            <p class="small">
              {r.items_run} labelled items · layers: {r.layers.join(", ")} · run{" "}
              {r.run_at.slice(0, 10)} · test set{" "}
              <span class="mono">{r.golden_sha256.slice(0, 12)}</span> ·{" "}
              {r.pass ? (
                <span class="pill pass">all targets met</span>
              ) : (
                <span class="pill fail">targets missed</span>
              )}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Result</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {GOLDEN_METRICS.map(([key, label]) => {
                  const m = r.metrics[key];
                  return (
                    <tr>
                      <td>{label}</td>
                      <td>
                        {pct(m.n, m.d)}{" "}
                        <span class="muted small">
                          ({m.n}/{m.d})
                        </span>
                      </td>
                      <td>
                        {m.direction === "max" ? "≤" : "≥"} {(m.target * 100).toFixed(0)}%{" "}
                        {m.met ? "✓" : "✗"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ))
      )}
      {p.suite.runs.length > 0 && p.suite.note ? <p class="small muted">{p.suite.note}</p> : null}
    </div>
  );
}

export function AccuracyPage(p: {
  report: {
    since: string;
    min_sample: number;
    verticals: {
      vertical: string;
      verifications: number;
      auto_decisions: number;
      escalated: number;
      disputed: number;
      reviewed: number;
      overturned: number;
      escalation_rate: number | null;
      overturn_rate: number | null;
      published: boolean;
    }[];
    golden_sets: typeof GOLDEN_RESULTS;
  };
}) {
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  return (
    <Page title="Accuracy">
      <h1>Verifier accuracy</h1>
      <p class="sub">
        How often each verifier gets it wrong: first on labelled test sets before release, then on
        live jobs.
      </p>

      <h2>Before release: labelled test sets (v0)</h2>
      <p class="small muted">
        Each test set mixes good work, flawed work and deliberate attacks, each with a known right
        answer. A miss on any target blocks release. Numbers cover only the layers listed; the test
        set hash identifies exactly which items were used.
      </p>
      {p.report.golden_sets.suites.map((s) => (
        <GoldenSuitePanel suite={s} />
      ))}

      <h2>Live jobs</h2>
      <p class="small muted">
        Live jobs since {p.report.since.slice(0, 10)}. An automatic decision counts as overturned
        when a human reviewer changed it, either in a pilot's shadow review (where a person checks
        every automatic decision before money moves) or on dispute. Rates are shown once a verifier
        has made at least {p.report.min_sample} automatic decisions.
      </p>
      {p.report.verticals.length === 0 ? (
        <div class="panel empty">No live verifications in this period yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Verifier</th>
              <th>Checks</th>
              <th>Automatic decisions</th>
              <th>Sent to a human</th>
              <th>Human-reviewed</th>
              <th>Disputed</th>
              <th>Overturned</th>
            </tr>
          </thead>
          <tbody>
            {p.report.verticals.map((v) => (
              <tr>
                <td>{v.vertical}</td>
                <td>{v.verifications}</td>
                <td>{v.auto_decisions}</td>
                <td>{v.published ? pct(v.escalation_rate) : "—"}</td>
                <td>{v.reviewed}</td>
                <td>{v.disputed}</td>
                <td>{v.published ? pct(v.overturn_rate) : "not enough data"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
