import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type LedgerProof, verifyLedgerProof } from "../packages/core/src/index.ts";

const state = () =>
  JSON.parse(readFileSync(join(import.meta.dirname, ".state.json"), "utf8")) as {
    opsKey: string;
    platformKey: string;
    escalated: string;
    final: string;
    reportPath: string;
    hostPage: string;
  };

/**
 * Collects console errors (CSP violations included), uncaught exceptions and failed
 * sub-resources. A page's own status (401 on a bad sign-in, 503 from /status when degraded) is
 * the test's business, so the console's report of it is ignored.
 */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) {
      problems.push(m.text());
    }
  });
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.request().resourceType() !== "document") {
      problems.push(`${r.status()} ${r.url()}`);
    }
  });
  page.on("requestfailed", (r) => problems.push(`failed ${r.url()}`));
  return problems;
}

async function signIn(page: Page, key: string) {
  await page.goto("/dashboard/login");
  await page.locator('input[name="api_key"]').fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a reviewer signs in, finds the escalated case and decides it", async ({ page }) => {
  const s = state();
  const problems = watchConsole(page);

  await signIn(page, "pd_test_not_a_real_key");
  await expect(page.getByText("That key isn't valid or has been revoked.")).toBeVisible();

  await signIn(page, s.opsKey);
  await page.goto("/dashboard/review");
  const row = page.getByRole("row").filter({ hasText: s.escalated });
  await expect(row).toContainText("Brief on heat pumps");
  await expect(row).toContainText("quotes-verbatim");
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/agreements/${s.escalated}$`));
  await expect(page.getByRole("heading", { name: "Decide" })).toBeVisible();

  // A partial release without a percentage is refused with a message, not an error page.
  await page.getByLabel(/Partial/).check();
  await page.locator('textarea[name="reason"]').fill("Half the sources are missing.");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("A partial release needs a whole percentage")).toBeVisible();

  await page.getByLabel(/Refund buyer/).check();
  await page
    .locator('textarea[name="reason"]')
    .fill("The quotes don't appear in the cited sources.");
  await page.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("Decision recorded.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decide" })).toHaveCount(0);

  // The queue no longer lists it.
  await page.goto("/dashboard/review");
  await expect(page.getByRole("row").filter({ hasText: s.escalated })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login/);
  expect(problems).toEqual([]);
});

test("a platform user can't reach the review queue", async ({ page }) => {
  await signIn(page, state().platformKey);
  await page.goto("/dashboard/review");
  await expect(page).not.toHaveURL(/\/dashboard\/review/);
});

test("the public verdict report renders, and its proof verifies offline", async ({
  page,
  request,
}) => {
  const s = state();
  const problems = watchConsole(page);
  const res = await page.goto(s.reportPath);
  expect(res?.headers()["content-security-policy"]).toContain("default-src");
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.getByRole("heading", { name: "Brief on grid storage" })).toBeVisible();
  await expect(page.getByText("hash chain intact")).toBeVisible();
  await expect(page.getByText("Every source loads and quotes match.")).toBeVisible();
  // Documents aren't on the public page.
  await expect(page.getByText("Findings, with sources.")).toHaveCount(0);

  const href = await page.getByRole("link", { name: "download the proof" }).getAttribute("href");
  const proof = (await (await request.get(href as string)).json()) as LedgerProof;
  expect(proof.agreement_id).toBe(s.final);
  expect(verifyLedgerProof(proof)).toEqual({ ok: true, problems: [] });
  expect(problems).toEqual([]);
});

test("public pages work without signing in: accuracy, pricing, status", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/accuracy");
  await expect(page.getByRole("heading", { name: "Verifier accuracy" })).toBeVisible();
  await expect(page.getByText("130 labelled items")).toBeVisible();
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  // 503 while degraded (no scheduler runs here), so uptime monitors notice.
  const status = await page.goto("/status");
  expect([200, 503]).toContain(status?.status());
  await expect(page.getByText(/operational|degraded/i).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("a marketplace on another site embeds the verdict widget", async ({ page }) => {
  const s = state();
  const problems = watchConsole(page);
  await page.goto(s.hostPage);
  const frame = page.frameLocator('iframe[title="Proof Desk verdict"]');
  await expect(frame.getByText("Brief on grid storage")).toBeVisible();
  await expect(frame.getByText("Passed")).toBeVisible();
  await expect(frame.getByText("Decided by a human reviewer")).toBeVisible();
  // The iframe resized itself to fit (from the 160px placeholder).
  const iframe = page.locator('iframe[title="Proof Desk verdict"]');
  await expect.poll(async () => (await iframe.boundingBox())?.height ?? 0).not.toBe(160);
  await expect(page.locator("#after")).toBeVisible();
  // The full report opens in a new tab.
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    frame.getByRole("link", { name: /Full report and proof/ }).click(),
  ]);
  await expect(popup.getByText("hash chain intact")).toBeVisible();
  expect(problems).toEqual([]);
});

test("a developer signs up for a sandbox key and uses it to sign in", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/signup");
  await page.getByLabel("Your company or project").fill("Acme Agents");
  await page.getByLabel("Email").fill("dev@acme.example");
  await page.getByRole("button", { name: "Create my sandbox key" }).click();
  await expect(page.getByRole("heading", { name: "Your sandbox key" })).toBeVisible();
  const key = (await page.locator("pre").first().textContent())?.trim() as string;
  expect(key).toMatch(/^pd_test_/);
  await signIn(page, key);
  await expect(page).toHaveURL(/\/dashboard\/?$/);
  expect(problems).toEqual([]);
});
