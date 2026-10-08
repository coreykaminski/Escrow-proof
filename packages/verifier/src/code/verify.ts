import type { StructuredCaller } from "../llm/claude.ts";
import { combine, decide } from "../policy.ts";
import type { CodeReport, CriterionSignal, Finding, TestCaseResult } from "../types.ts";
import { type CodeInput, prepareWorkspace } from "./prepare.ts";
import { parseTap, parseUnittest } from "./results.ts";
import { CODE_REVIEW_PROMPT_VERSION, judgeCode } from "./review.ts";
import type { Sandbox } from "./sandbox.ts";

export const CODE_ENGINE_VERSION = `code-v1/${CODE_REVIEW_PROMPT_VERSION}`;
const DEFAULT_TIMEOUT_MS = 60_000;
const TESTS_ROUTE = /\b(tests?|test suite|acceptance)\b/i;
const CONFIDENCE = { low: 0.5, medium: 0.75, high: 0.95 } as const;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Code verification:
 * 1. build the workspace (deliverable, then the buyer's tests and fixtures on top) and check it;
 * 2. run the buyer's acceptance tests in the sandbox; each test counts toward the criterion it's
 *    tagged with ("[id] …"), untagged ones toward the criterion about tests. A failing test that
 *    no criterion covers still fails the job (override), as do timeouts and runs with no results;
 * 3. criteria tests can't settle (check "judge", or no tests) go to the model judge, which also
 *    looks for code that special-cases the tests; without a model they stay uncertain, so the
 *    case goes to a human;
 * 4. the shared decision policy picks release / refund / escalate.
 */
export async function verifyCode(
  input: CodeInput,
  deps: { sandbox: Sandbox; caller?: StructuredCaller; timeoutMs?: number; now?: () => number },
): Promise<CodeReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const ws = prepareWorkspace(input);
  if (!deps.sandbox.runtimes.includes(ws.runtime)) {
    throw new Error(`the ${deps.sandbox.name} sandbox can't run ${ws.runtime} tests`);
  }
  const findings: Finding[] = [...ws.findings];
  const run = await deps.sandbox.run({
    runtime: ws.runtime,
    files: ws.files,
    tests: ws.tests,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const cases: TestCaseResult[] =
    ws.runtime === "node" ? parseTap(run.stdout) : parseUnittest(run.stderr);
  const output = `${run.stdout}\n${run.stderr}`;

  if (run.timedOut) {
    findings.push({
      kind: "timeout",
      severity: "critical",
      confidence: "high",
      message: "The tests didn't finish in time (possible infinite loop or hang).",
    });
  }
  const denied = /ERR_ACCESS_DENIED[^\n]*/.exec(output);
  if (denied) {
    findings.push({
      kind: "sandbox_violation",
      severity: "major",
      confidence: "high",
      message: `The code tried something the sandbox forbids (network, files outside the workspace, or processes): ${denied[0].slice(0, 200)}`,
    });
  }
  if (cases.length === 0 && !run.timedOut) {
    findings.push({
      kind: "tests_not_run",
      severity: "critical",
      confidence: "high",
      message: `The tests didn't run: ${squash(run.stderr).slice(-300) || "no results"}`,
    });
  }
  const failed = cases.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    findings.push({
      kind: "tests_failed",
      severity: "critical",
      confidence: "high",
      message: `${failed.length} of ${cases.length} acceptance tests failed: ${failed
        .slice(0, 5)
        .map((c) => c.name)
        .join("; ")}${failed.length > 5 ? "; …" : ""}`,
    });
  }

  // --- Test signals per criterion ---
  const criteria = input.spec.criteria;
  const ids = new Set(criteria.map((c) => c.id));
  const testsRoute = criteria.find(
    (c) => c.check !== "judge" && TESTS_ROUTE.test(`${c.id.replace(/-/g, " ")} ${c.description}`),
  );
  const byCriterion = new Map<string, TestCaseResult[]>();
  const orphans: TestCaseResult[] = [];
  for (const t of cases) {
    const id = t.criterion_id && ids.has(t.criterion_id) ? t.criterion_id : testsRoute?.id;
    if (id) byCriterion.set(id, [...(byCriterion.get(id) ?? []), t]);
    else orphans.push(t);
  }
  const broken = run.timedOut || cases.length === 0;
  if (broken && testsRoute && !byCriterion.has(testsRoute.id)) byCriterion.set(testsRoute.id, []);

  const signals: CriterionSignal[] = [];
  for (const [id, tests] of byCriterion) {
    const bad = tests.filter((t) => t.status === "fail");
    if (bad.length > 0 || broken) {
      signals.push({
        criterion_id: id,
        source: "deterministic",
        verdict: "fail",
        confidence: 0.99,
        reason: broken
          ? run.timedOut
            ? "The tests timed out."
            : "The tests didn't run."
          : `${bad.length} of ${tests.length} tests failed: ${bad.map((t) => t.name).join("; ")}`,
        evidence: bad.slice(0, 3).map((t) => ({ target: t.message ?? t.name })),
      });
    } else if (tests.some((t) => t.status === "pass")) {
      signals.push({
        criterion_id: id,
        source: "deterministic",
        verdict: "pass",
        confidence: 0.95,
        reason: `All ${tests.length} tests passed.`,
      });
    }
  }
  const overrides: Finding[] = findings.filter(
    (f) =>
      (f.kind === "timeout" || f.kind === "tests_not_run" || f.kind === "empty_deliverable") &&
      !testsRoute,
  );
  if (orphans.some((t) => t.status === "fail")) {
    overrides.push({
      kind: "tests_failed",
      severity: "critical",
      confidence: "high",
      message: `Acceptance tests failed: ${orphans
        .filter((t) => t.status === "fail")
        .slice(0, 5)
        .map((t) => t.name)
        .join("; ")}`,
    });
  }

  // --- Model judge for what the tests can't settle ---
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const forJudge = criteria.filter((c) => c.check === "judge" || !byCriterion.has(c.id));
  const code = input.deliverable.map((f) => f.content).join("\n");
  const inCode = (q: string) => q.trim().length > 0 && squash(code).includes(squash(q));
  const suspicious = findings.filter((f) => f.kind === "sandbox_violation");
  let gaming: string | null = suspicious.length
    ? `${suspicious.map((f) => f.message).join(" ")}`
    : null;
  let modelInjection = false;
  const hardFail =
    overrides.length > 0 ||
    signals.some(
      (s) => s.verdict === "fail" && criteria.find((c) => c.id === s.criterion_id)?.critical,
    );
  if (deps.caller && !hardFail && (forJudge.length > 0 || cases.length > 0)) {
    const { output: j, usage: u } = await judgeCode(deps.caller, {
      spec: input.spec,
      criteria: forJudge,
      deliverable: input.deliverable,
      tests: cases,
    });
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.cost_usd += u.cost_usd;
    modelInjection = j.injection_detected;
    if (j.special_cases_tests && inCode(j.special_case_evidence)) {
      gaming = `${gaming ? `${gaming} Also, ` : ""}the code appears to special-case the tests ("${j.special_case_evidence.slice(0, 160)}").`;
    }
    const judged = new Set(forJudge.map((c) => c.id));
    for (const r of j.criteria) {
      if (!judged.has(r.criterion_id)) continue;
      let confidence: number = CONFIDENCE[r.confidence];
      let reason = r.reason;
      if (r.verdict === "fail" && !r.evidence.some(inCode)) {
        confidence = Math.min(confidence, 0.5);
        reason += " (evidence not found in the code)";
      }
      signals.push({
        criterion_id: r.criterion_id,
        source: "judge",
        verdict: r.verdict,
        confidence,
        reason,
        evidence: r.evidence.map((target) => ({ target })),
      });
    }
  }

  const results = combine(criteria, signals);
  const injection = findings.some((f) => f.kind === "injection_suspected") || modelInjection;
  const decision = decide(results, { injection, overrides, gaming });
  return {
    engine_version: CODE_ENGINE_VERSION,
    vertical: "code",
    findings,
    criteria: results,
    decision,
    tests: {
      runtime: ws.runtime,
      sandbox: deps.sandbox.name,
      exit_code: run.exitCode,
      timed_out: run.timedOut,
      duration_ms: run.durationMs,
      passed: cases.filter((c) => c.status === "pass").length,
      failed: failed.length,
      cases,
      log: output.slice(-4000),
    },
    usage: { ...usage, cost_usd: Math.round(usage.cost_usd * 1e6) / 1e6 },
    latency_ms: now() - started,
  };
}
