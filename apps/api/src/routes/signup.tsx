/**
 * Self-serve sandbox sign-up: a page for people and a JSON endpoint for scripts and agents.
 * Test keys only; rate-limited per IP; switch off with SELF_SERVE_SIGNUP=off.
 */
import { Hono } from "hono";
import { z } from "zod";
import { Flash, Page } from "../dashboard/ui.tsx";
import type { AppDeps } from "../env.ts";
import { ApiError } from "../errors.ts";
import { sandboxLimitsFromEnv, signUp } from "../services/signup.ts";

export const SignupBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254),
});

function SignupPage(p: { error?: string; values?: { name?: string; email?: string } }) {
  const limits = sandboxLimitsFromEnv();
  return (
    <Page title="Get a sandbox key">
      <div class="panel" style="max-width:520px;margin:40px auto">
        <h1>Get a sandbox key</h1>
        <p class="sub">
          Try Proof Desk with test money: create agreements, run real checks, receive webhooks.
          Includes {limits.checksPerDay} verifications and {limits.draftsPerDay} AI spec drafts a
          day. Live keys are set up with us.
        </p>
        <Flash error={p.error} />
        <form method="post" action="/signup">
          <label class="small" for="signup-name">
            Your company or project
          </label>
          <input
            id="signup-name"
            name="name"
            required
            minlength={2}
            maxlength={100}
            value={p.values?.name ?? ""}
            style="width:100%;margin-bottom:10px"
          />
          <label class="small" for="signup-email">
            Email
          </label>
          <input
            id="signup-email"
            name="email"
            type="email"
            required
            value={p.values?.email ?? ""}
            style="width:100%;margin-bottom:12px"
          />
          <button class="primary" type="submit">
            Create my sandbox key
          </button>
        </form>
      </div>
    </Page>
  );
}

function KeyPage(p: { apiKey: string; base: string }) {
  return (
    <Page title="Your sandbox key">
      <div class="panel" style="max-width:640px;margin:40px auto">
        <h1>Your sandbox key</h1>
        <p class="sub">
          Copy it now: it's shown only once, and we only keep a hash of it. It works with test money
          only.
        </p>
        <pre class="doc mono" style="padding:12px;border:1px solid var(--line);border-radius:8px">
          {p.apiKey}
        </pre>
        <h2>Next</h2>
        <pre class="doc mono">{`npm install @proofdesk/sdk

import { ProofDesk } from "@proofdesk/sdk";
const pd = new ProofDesk({ apiKey: "${p.apiKey.slice(0, 12)}…", baseUrl: "${p.base}" });
const templates = await pd.specTemplates.list();`}</pre>
        <p class="small">
          Then follow the <a href="/docs">API reference</a>, or sign in to the{" "}
          <a href="/dashboard/login">dashboard</a> with this key to watch your agreements.
        </p>
      </div>
    </Page>
  );
}

export function signupRoutes(deps: AppDeps) {
  const { db } = deps;
  const r = new Hono();
  const enabled = deps.selfServeSignup !== false;
  const off = () => new ApiError(404, "route_not_found", "self-serve sign-up is off");

  r.get("/signup", (c) => {
    if (!enabled) throw off();
    return c.html(<SignupPage />);
  });

  r.post("/signup", async (c) => {
    if (!enabled) throw off();
    const form = await c.req.parseBody();
    const values = { name: String(form.name ?? ""), email: String(form.email ?? "") };
    const parsed = SignupBody.safeParse(values);
    if (!parsed.success) {
      return c.html(
        <SignupPage error="Enter a name (2+ characters) and a valid email." values={values} />,
        400,
      );
    }
    const { apiKey } = await signUp(db, parsed.data);
    return c.html(
      <KeyPage apiKey={apiKey} base={deps.publicUrl ?? new URL(c.req.url).origin} />,
      201,
    );
  });

  /** The same for scripts and agents: { name, email } → a test-mode key, shown once. */
  r.post("/sandbox/signup", async (c) => {
    if (!enabled) throw off();
    const body = SignupBody.parse(await c.req.json());
    const { accountId, apiKey } = await signUp(db, body);
    const limits = sandboxLimitsFromEnv();
    return c.json(
      {
        object: "sandbox_account",
        account_id: accountId,
        api_key: apiKey,
        mode: "test",
        daily_limits: { verifications: limits.checksPerDay, spec_drafts: limits.draftsPerDay },
        docs: `${deps.publicUrl ?? new URL(c.req.url).origin}/docs`,
      },
      201,
    );
  });

  return r;
}
