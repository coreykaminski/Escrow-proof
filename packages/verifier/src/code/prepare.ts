import type { Spec } from "@proofdesk/core";
import { INJECTION_PATTERNS } from "../translation/text.ts";
import type { Finding } from "../types.ts";
import { type Runtime, type SandboxFile, safePath } from "./sandbox.ts";

export interface CodeFile {
  name: string;
  content: string;
}

export interface CodeInput {
  spec: Spec;
  /** The buyer's files: acceptance tests and any fixtures. They always win over the deliverable. */
  inputs: CodeFile[];
  /** The seller's files. */
  deliverable: CodeFile[];
}

const NODE_TEST = /(^|\/)([^/]+\.test\.(mjs|cjs|js|ts|mts)|test\/[^/]+\.(mjs|cjs|js|ts|mts))$/;
const PY_TEST = /(^|\/)test_[^/]+\.py$/;
const MAX_FILES = 200;
const MAX_BYTES = 2_000_000;

/** Phrases in code addressed to the verifier (comments, strings). */
const CODE_INJECTION: RegExp[] = [
  ...INJECTION_PATTERNS,
  /\b(verifier|reviewer|grader|judge|evaluator)\s*[:,-]\s*(release|approve|pass|accept)/i,
  /\b(release|approve)\s+(the\s+)?(payment|funds)\b/i,
];

/**
 * Capabilities a typical task doesn't need. Code reaching for them (to exfiltrate, or to probe
 * the sandbox) goes to a human even if the tests pass, unless the task is about them.
 */
const SUSPICIOUS_APIS: [RegExp, string][] = [
  [
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|["']node:(net|http|https|dgram|tls|dns)["']|\brequire\(\s*["'](net|http|https|dgram|tls|dns)["']|\bimport\s+(socket|requests|urllib|http\.client)\b/,
    "network access",
  ],
  [
    /["']node:child_process["']|\brequire\(\s*["']child_process["']|\bimport\s+subprocess\b|\bos\.system\s*\(/,
    "spawning processes",
  ],
  [/\bprocess\.env\b|\bos\.environ\b/, "reading environment variables"],
  [/\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*compile/, "dynamic code evaluation"],
];
const TASK_NEEDS =
  /\b(http|https|fetch|network|socket|api client|download|url|subprocess|shell|command line|environment variable|env var|eval)\b/i;

export class CodeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeInputError";
  }
}

/**
 * Builds the sandbox workspace: the deliverable's files, then the buyer's inputs on top, so a
 * deliverable can never replace or weaken the tests. Static findings come along.
 */
export function prepareWorkspace(input: CodeInput): {
  runtime: Runtime;
  files: SandboxFile[];
  tests: string[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const tests = input.inputs.map((f) => f.name).filter((n) => NODE_TEST.test(n) || PY_TEST.test(n));
  if (tests.length === 0) {
    throw new CodeInputError(
      "a code agreement needs its acceptance tests attached as inputs (e.g. tests/acceptance.test.mjs or test_acceptance.py)",
    );
  }
  const runtimes = new Set(tests.map((t) => (PY_TEST.test(t) ? "python" : "node")));
  if (runtimes.size > 1)
    throw new CodeInputError("acceptance tests must all be node or all python");
  const runtime = [...runtimes][0] as Runtime;
  for (const f of input.inputs) {
    if (!safePath(f.name)) throw new CodeInputError(`input path not allowed: ${f.name}`);
  }

  const inputNames = new Set(input.inputs.map((f) => f.name));
  const files = new Map<string, string>();
  let bytes = 0;
  const delivered = input.deliverable.filter((f) => f.content.trim().length > 0);
  if (delivered.length === 0) {
    findings.push({
      kind: "empty_deliverable",
      severity: "critical",
      confidence: "high",
      message: "The delivery contains no code.",
    });
  }
  for (const f of input.deliverable.slice(0, MAX_FILES)) {
    if (!safePath(f.name)) {
      findings.push({
        kind: "path_not_allowed",
        severity: "major",
        confidence: "high",
        message: `Delivered file ${JSON.stringify(f.name)} has a path outside the workspace; it was not used.`,
      });
      continue;
    }
    if (inputNames.has(f.name)) {
      findings.push({
        kind: "tests_tampered",
        severity: "major",
        confidence: "high",
        message: `The delivery includes ${f.name}, which is one of the buyer's files; the buyer's version was used.`,
      });
      continue;
    }
    bytes += f.content.length;
    if (bytes > MAX_BYTES) {
      findings.push({
        kind: "path_not_allowed",
        severity: "major",
        confidence: "high",
        message: "The delivery is over 2 MB; remaining files were not used.",
      });
      break;
    }
    files.set(f.name, f.content);
    if (
      !TASK_NEEDS.test(
        `${input.spec.request} ${input.spec.criteria.map((c) => c.description).join(" ")}`,
      )
    ) {
      for (const [re, what] of SUSPICIOUS_APIS) {
        const m = re.exec(f.content);
        if (m) {
          findings.push({
            kind: "sandbox_violation",
            severity: "major",
            confidence: "medium",
            message: `${f.name} uses ${what} ("${m[0].trim()}"), which this task doesn't call for.`,
            evidence: { target: m[0].trim() },
          });
        }
      }
    }
    for (const re of CODE_INJECTION) {
      const m = re.exec(f.content);
      if (m) {
        findings.push({
          kind: "injection_suspected",
          severity: "major",
          confidence: "medium",
          message: `${f.name} contains text addressed to the verifier: "${m[0]}"`,
          evidence: { target: m[0] },
        });
        break;
      }
    }
  }
  for (const f of input.inputs) files.set(f.name, f.content);
  return {
    runtime,
    files: [...files].map(([path, content]) => ({ path, content })),
    tests,
    findings,
  };
}
