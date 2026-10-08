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
      <p class="sub">Escalated by the verifier or disputed by a party. Oldest first.</p>
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
  const needsDecision = p.viewer.isOps && (a.status === "escalated" || a.status === "disputed");
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
          <h2>{a.status === "disputed" ? "Resolve the dispute (final)" : "Decide"}</h2>
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
                Record decision
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
                      {f.kind.replace("_", " ")}
                    </span>
                  </td>
                  <td class="small">{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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
export function ReportPage(p: { file: CaseFile; ledgerOk: boolean }) {
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
