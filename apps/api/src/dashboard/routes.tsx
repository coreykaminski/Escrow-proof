import { AGREEMENT_STATES, TransitionError } from "@proofdesk/core";
import { schema } from "@proofdesk/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps } from "../env.ts";
import { ApiError } from "../errors.ts";
import { applyEvent, listAgreements } from "../services/agreements.ts";
import { ledgerIntact, loadCaseFile, reviewerStats, reviewQueue } from "../services/case-file.ts";
import { getHold, syncHold } from "../services/payments.ts";
import {
  endSession,
  getSession,
  SESSION_HOURS,
  type Session,
  startSession,
} from "../services/sessions.ts";
import { createShareLink, resolveShareLink } from "../services/share-links.ts";
import {
  AgreementsPage,
  CasePage,
  LoginPage,
  PAY_JS,
  PayPage,
  QueuePage,
  ReportPage,
  ReviewersPage,
  type Viewer,
} from "./pages.tsx";

const COOKIE = "pd_session";

type DashEnv = { Variables: { session: Session } };

const viewerOf = (s: Session): Viewer => ({
  accountName: s.accountName,
  isOps: s.scopes.includes("ops"),
  mode: s.mode,
  csrfToken: s.csrfToken,
});

/** Base URL for links we hand out: the configured public URL, else this request's origin. */
const baseUrl = (deps: AppDeps, requestUrl: string) => deps.publicUrl ?? new URL(requestUrl).origin;

/**
 * Server-rendered dashboard: platforms see their agreements; ops reviewers get the review queue
 * and record decisions. Signed in with an API key (exchanged for an HttpOnly session cookie);
 * every form post carries the session's CSRF token.
 */
export function dashboardRoutes(deps: AppDeps) {
  const { db, now } = deps;
  const r = new Hono<DashEnv>();

  r.get("/login", (c) => c.html(<LoginPage />));

  r.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const id = await startSession(db, String(form.api_key ?? ""), now());
    if (!id) return c.html(<LoginPage error="That key isn't valid or has been revoked." />, 401);
    setCookie(c, COOKIE, id, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_HOURS * 3600,
    });
    return c.redirect("/dashboard");
  });

  // Everything below needs a session.
  r.use("*", async (c, next) => {
    const session = await getSession(db, getCookie(c, COOKIE), now());
    if (!session) return c.redirect("/dashboard/login");
    c.set("session", session);
    if (c.req.method === "POST") {
      const form = await c.req.parseBody();
      if (form.csrf !== session.csrfToken)
        throw new ApiError(403, "csrf", "form expired; reload the page");
    }
    await next();
  });

  r.post("/logout", async (c) => {
    await endSession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/dashboard/login");
  });

  r.get("/", async (c) => {
    const s = c.get("session");
    const q = c.req.query("status");
    const valid = AGREEMENT_STATES.find((st) => st === q);
    const rows = s.scopes.includes("ops")
      ? await db
          .select()
          .from(schema.agreements)
          .where(valid ? eq(schema.agreements.status, valid) : undefined)
          .orderBy(desc(schema.agreements.updatedAt))
          .limit(200)
      : await listAgreements(db, s.accountId, { limit: 100, ...(valid ? { status: valid } : {}) });
    return c.html(
      <AgreementsPage viewer={viewerOf(s)} rows={rows} {...(valid ? { status: valid } : {})} />,
    );
  });

  const caseScope = (s: Session) => (s.scopes.includes("ops") ? {} : { accountId: s.accountId });

  r.get("/agreements/:id", async (c) => {
    const s = c.get("session");
    const file = await loadCaseFile(db, c.req.param("id"), caseScope(s));
    return c.html(<CasePage viewer={viewerOf(s)} file={file} />);
  });

  r.post("/agreements/:id/report-link", async (c) => {
    const s = c.get("session");
    const file = await loadCaseFile(db, c.req.param("id"), caseScope(s));
    const { token } = await createShareLink(db, {
      kind: "report",
      agreementId: file.agreement.id,
      createdByKeyId: s.apiKeyId,
      ttlDays: 30,
      now: now(),
    });
    const shareUrl = `${baseUrl(deps, c.req.url)}/r/${token}`;
    return c.html(
      <CasePage
        viewer={viewerOf(s)}
        file={file}
        shareUrl={shareUrl}
        flash={{ ok: "Share link created." }}
      />,
    );
  });

  /** A reviewer's decision: escalated → decided, or disputed → final resolution. */
  r.post("/agreements/:id/decision", async (c) => {
    const s = c.get("session");
    if (!s.scopes.includes("ops"))
      throw new ApiError(403, "insufficient_scope", "only reviewers can decide");
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const kind = String(form.outcome ?? "");
    const reason = String(form.reason ?? "").trim();
    const percent = Number(form.release_percent);
    const render = async (flash: { ok?: string; error?: string }, status: 200 | 400 | 409 = 200) =>
      c.html(
        <CasePage viewer={viewerOf(s)} file={await loadCaseFile(db, id, {})} flash={flash} />,
        status,
      );

    if (!["release", "refund", "partial"].includes(kind) || reason.length === 0) {
      return render({ error: "Choose an outcome and give a reason." }, 400);
    }
    if (kind === "partial" && !(Number.isInteger(percent) && percent >= 1 && percent <= 99)) {
      return render({ error: "A partial release needs a whole percentage from 1 to 99." }, 400);
    }
    const outcome =
      kind === "partial"
        ? { kind: "partial" as const, releasePercent: percent }
        : { kind: kind as "release" | "refund" };
    const actor = { role: "ops" as const, ref: s.apiKeyId };
    const current = (await loadCaseFile(db, id, {})).agreement;
    try {
      await applyEvent(db, {
        agreementId: id,
        scope: {},
        actor,
        now: now(),
        event:
          current.status === "disputed"
            ? { type: "RESOLVE_DISPUTE", outcome, reason }
            : { type: "DECIDE", outcome, decidedBy: "human", confidence: null, reason },
      });
    } catch (err) {
      if (err instanceof TransitionError) return render({ error: err.message }, 409);
      throw err;
    }
    return render({
      ok:
        current.status === "disputed"
          ? "Dispute resolved. This decision is final."
          : "Decision recorded.",
    });
  });

  r.get("/review", async (c) => {
    const s = c.get("session");
    if (!s.scopes.includes("ops")) return c.redirect("/dashboard");
    return c.html(<QueuePage viewer={viewerOf(s)} items={await reviewQueue(db)} now={now()} />);
  });

  r.get("/reviewers", async (c) => {
    const s = c.get("session");
    if (!s.scopes.includes("ops")) return c.redirect("/dashboard");
    const days = 30;
    const rows = await reviewerStats(db, new Date(now().getTime() - days * 86_400_000));
    return c.html(<ReviewersPage viewer={viewerOf(s)} rows={rows} days={days} />);
  });

  return r;
}

/** Public pages reached by unguessable links: verdict reports and the hosted card page. */
export function publicLinkRoutes(deps: AppDeps) {
  const { db, now, payments } = deps;
  const r = new Hono();

  r.get("/r/:token", async (c) => {
    const id = await resolveShareLink(db, c.req.param("token"), "report", now());
    if (!id) return c.html(<LinkGone />, 404);
    const file = await loadCaseFile(db, id, {});
    return c.html(<ReportPage file={file} ledgerOk={await ledgerIntact(db)} />);
  });

  r.get("/pay/assets/pay.js", (c) =>
    c.body(PAY_JS, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );

  const payPage = async (token: string, requestUrl: string) => {
    const id = await resolveShareLink(db, token, "pay", now());
    if (!id || !payments) return null;
    const hold = await getHold(db, id);
    if (!hold) return null;
    await syncHold(db, payments, hold.paymentIntentId, now());
    const state = await payments.getHold(hold.paymentIntentId);
    const file = await loadCaseFile(db, id, {});
    return (
      <PayPage
        agreement={file.agreement}
        clientSecret={state.client_secret}
        publishableKey={deps.stripePublishableKey}
        status={state.status}
        returnUrl={`${baseUrl(deps, requestUrl)}/pay/${token}`}
      />
    );
  };

  // Stripe sends the buyer back here after confirming; the page re-syncs the hold.
  r.get("/pay/:token", async (c) => {
    const page = await payPage(c.req.param("token"), c.req.url);
    return page ? c.html(page) : c.html(<LinkGone />, 404);
  });

  return r;
}

function LinkGone() {
  return (
    <html lang="en">
      <body style="font-family:sans-serif;padding:40px">
        <h1>This link has expired or doesn't exist.</h1>
        <p>Ask whoever sent it for a new one.</p>
      </body>
    </html>
  );
}
