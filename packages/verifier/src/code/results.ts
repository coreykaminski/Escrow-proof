import type { TestCaseResult } from "../types.ts";

const CRITERION_TAG = /^\s*(?:\[([a-z0-9][a-z0-9_-]{0,63})\]|([a-z0-9][a-z0-9_-]{0,63}):\s)/;

/** A test tagged "[criterion-id] …" or "criterion-id: …" counts toward that criterion. */
export function criterionOf(name: string): string | null {
  const m = CRITERION_TAG.exec(name);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Top-level results from Node's TAP reporter. Subtests are indented and folded into their
 * parent. A test file that fails to load shows up as one failing entry named after the file.
 */
export function parseTap(out: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(lines[i] ?? "");
    if (!m) continue;
    const name = (m[2] ?? "").trim();
    const status = m[3] ? "skip" : m[1] === "ok" ? "pass" : "fail";
    let message: string | undefined;
    if (status === "fail") {
      // The YAML diagnostic block follows, indented: find its error line.
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j] ?? ""); j++) {
        const e = /^\s+error:\s*(.*)$/.exec(lines[j] ?? "");
        if (e) {
          message = (e[1] ?? "").replace(/^['"|>-]+\s*|['"]$/g, "").slice(0, 500);
          if (!message && lines[j + 1]) message = (lines[j + 1] ?? "").trim().slice(0, 500);
          break;
        }
      }
    }
    cases.push({
      name,
      criterion_id: criterionOf(name),
      status,
      ...(message ? { message } : {}),
    });
  }
  return cases;
}

/** Results from `python -m unittest -v` (written to stderr). Docstrings tag criteria. */
export function parseUnittest(out: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^(test\w*) \(([\w.]+)\)(?:\n)?(.*?)\s*\.\.\.\s*(ok|FAIL|ERROR|skipped.*)$/.exec(
      line,
    );
    const head = /^(test\w*) \(([\w.]+)\)$/.exec(line);
    let name: string;
    let doc = "";
    let result: string;
    if (m) {
      name = m[1] ?? "";
      doc = (m[3] ?? "").trim();
      result = m[4] ?? "";
    } else if (head) {
      // Docstring on the next line: "test_x (mod.Class.test_x)\nDoc line ... ok"
      const next = /^(.*?)\s*\.\.\.\s*(ok|FAIL|ERROR|skipped.*)$/.exec(lines[i + 1] ?? "");
      if (!next) continue;
      name = head[1] ?? "";
      doc = (next[1] ?? "").trim();
      result = next[2] ?? "";
      i++;
    } else {
      continue;
    }
    const label = doc || name;
    cases.push({
      name: label,
      criterion_id: criterionOf(label),
      status: result === "ok" ? "pass" : result.startsWith("skipped") ? "skip" : "fail",
    });
  }
  return cases;
}
