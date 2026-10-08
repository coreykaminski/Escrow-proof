import { createHmac, timingSafeEqual } from "node:crypto";
import type { TestCaseResult } from "../types.ts";
import { criterionOf } from "./results.ts";

/**
 * Delivered code runs in the same process as the buyer's tests, so it could monkeypatch
 * `assert`, silence the reporter and print fake "ok" lines, or exit early. The trusted runner
 * loads before any delivered code and:
 * 1. takes a one-time key (stdin, or a file it deletes at once) the delivery can never read;
 * 2. freezes the assertion libraries, the test API, and the stream/event prototypes the results
 *    flow through (Node also runs with --frozen-intrinsics);
 * 3. runs the tests with node:test's run() and reports them as ONE line signed with the key.
 * The verifier trusts nothing else in the output: forged lines don't verify, and an early exit
 * leaves no signed line, which counts as "the tests didn't run".
 */

export const RUNNER_DIR = ".pd";

export const NODE_RUNNER = `import { createHmac } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import assert from "node:assert";
import assertStrict from "node:assert/strict";
import * as testApi from "node:test";
import { run } from "node:test";
import { Duplex, PassThrough, Readable, Stream, Transform, Writable } from "node:stream";
import { EventEmitter } from "node:events";

const key =
  process.env.PD_KEY_SOURCE === "file"
    ? (() => {
        const k = readFileSync(".pd/key");
        unlinkSync(".pd/key");
        return k;
      })()
    : readFileSync(0);
const out = process.stdout;
const write = out.write.bind(out);
const sign = (s) => createHmac("sha256", key).update(s).digest("hex");

// Assertions and the test API: frozen outright (module namespaces already are).
for (const o of [assert, assertStrict, assert.strict, testApi.default, testApi.test, testApi.describe, testApi.it]) {
  if (o) Object.freeze(o);
}
// Results flow through streams and emitters. Freezing those prototypes would break instance
// construction (inherited read-only fields), so lock their methods instead.
const lockMethods = (o) => {
  if (!o) return;
  for (const k of Reflect.ownKeys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && typeof d.value === "function" && d.configurable) {
      Object.defineProperty(o, k, { value: d.value, writable: false, configurable: false, enumerable: d.enumerable });
    }
  }
};
for (const o of [
  Readable, Readable.prototype, Writable, Writable.prototype, Duplex.prototype, Transform.prototype,
  PassThrough.prototype, Stream, Stream.prototype, EventEmitter, EventEmitter.prototype, testApi.mock,
]) {
  lockMethods(o);
}
Object.defineProperty(out, "write", { value: out.write, writable: false, configurable: false });
if (!Object.isFrozen(assert) || !Object.isFrozen(assertStrict) || Object.getOwnPropertyDescriptor(Readable.prototype, "push").writable) {
  throw new Error("runner hardening failed");
}

const files = process.argv.slice(2);
const results = [];
for await (const ev of run({ files, isolation: "none", timeout: 10000 })) {
  if ((ev.type === "test:pass" || ev.type === "test:fail") && ev.data.nesting === 0) {
    results.push({
      name: String(ev.data.name),
      status: ev.type === "test:fail" ? "fail" : ev.data.skip || ev.data.todo ? "skip" : "pass",
      message: ev.type === "test:fail" ? String(ev.data.details?.error?.message ?? "").slice(0, 500) : undefined,
    });
  }
}
const payload = Buffer.from(JSON.stringify(results)).toString("base64");
write("\\nPDRESULT " + payload + " " + sign(payload) + "\\n");
`;

export const PYTHON_RUNNER = `import base64, hashlib, hmac, json, os, sys, unittest

sys.path.insert(0, os.getcwd())

_key = open(".pd/key", "rb").read()
os.unlink(".pd/key")
_write = sys.__stdout__.write
_flush = sys.__stdout__.flush
_new = hmac.new
_sha = hashlib.sha256
_dumps = json.dumps
_b64 = base64.b64encode

results = []

class _Result(unittest.TestResult):
    def _add(self, test, status, err=None):
        doc = test.shortDescription()
        name = doc or test.id().split(".")[-1]
        results.append({"name": name, "status": status, "message": (str(err[1])[:500] if err else None)})
    def addSuccess(self, test): self._add(test, "pass")
    def addFailure(self, test, err): self._add(test, "fail", err)
    def addError(self, test, err): self._add(test, "fail", err)
    def addSkip(self, test, reason): self._add(test, "skip")

suite = unittest.defaultTestLoader.loadTestsFromNames([m[:-3].replace("/", ".") for m in sys.argv[1:]])
suite.run(_Result())
payload = _b64(_dumps(results).encode()).decode()
_write("\\nPDRESULT " + payload + " " + _new(_key, payload.encode(), _sha).hexdigest() + "\\n")
_flush()
`;

/** The signed results line, verified with the run's key; null if absent or forged. */
export function parseSignedResults(stdout: string, key: Buffer): TestCaseResult[] | null {
  const lines = stdout.split("\n").filter((l) => l.startsWith("PDRESULT "));
  for (const line of lines.reverse()) {
    const [, payload = "", mac = ""] = line.trim().split(" ");
    const expected = createHmac("sha256", key).update(payload).digest();
    const given = Buffer.from(mac, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
    try {
      const raw = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
        name: string;
        status: "pass" | "fail" | "skip";
        message?: string | null;
      }[];
      return raw.map((r) => ({
        name: r.name,
        criterion_id: criterionOf(r.name),
        status: r.status,
        ...(r.message ? { message: r.message } : {}),
      }));
    } catch {
      return null;
    }
  }
  return null;
}
