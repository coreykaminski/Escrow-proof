import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where deliverable code runs against the buyer's tests. Deliverables are untrusted code, so a
 * sandbox must deny network, writes outside scratch space, process spawning and host files, and
 * bound time, memory and output.
 *
 * - DockerSandbox: production. No network, read-only root, dropped capabilities, non-root user,
 *   memory/CPU/PID limits; optionally gVisor (`runsc`) for a kernel boundary.
 * - NodePermissionSandbox: development and CI. Node's permission model (no network, no child
 *   processes, reads only the workspace, no writes). Node documents it as a seatbelt, not a
 *   security boundary against malicious code, so don't use it for untrusted production jobs.
 */

export type Runtime = "node" | "python";

export interface SandboxFile {
  path: string;
  content: string;
}

export interface SandboxRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface Sandbox {
  readonly name: string;
  readonly runtimes: readonly Runtime[];
  run(p: {
    runtime: Runtime;
    files: SandboxFile[];
    /** Test files to run (paths within files). */
    tests: string[];
    timeoutMs: number;
  }): Promise<SandboxRun>;
}

export const OUTPUT_LIMIT = 256 * 1024;
const PER_TEST_TIMEOUT_MS = 10_000;

/** Paths inside the workspace only: relative, no `..`, conservative characters. */
export function safePath(p: string): string | null {
  if (p.length === 0 || p.length > 200 || p.includes("\0") || p.includes("\\")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.length > 8 || parts.some((x) => x === "" || x === "." || x === "..")) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return null;
  return p;
}

/** The test command for a runtime (reporters chosen so results can be parsed). */
export function testCommand(runtime: Runtime, tests: string[]): string[] {
  if (runtime === "node") {
    return [
      "--test",
      "--test-isolation=none",
      "--test-reporter=tap",
      `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
      ...tests,
    ];
  }
  return ["-m", "unittest", "-v", ...tests.map((t) => t.replace(/\.py$/, "").replaceAll("/", "."))];
}

async function writeWorkspace(files: SandboxFile[]): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "pd-sbx-"));
  for (const f of files) {
    const rel = safePath(f.path);
    if (!rel) throw new Error(`unsafe path ${JSON.stringify(f.path)}`);
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), f.content);
  }
  return dir;
}

/** Runs a process with a hard timeout and capped output. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onTimeout?: () => void },
): Promise<SandboxRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: String(err),
        timedOut: false,
        durationMs: 0,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const cap = (buf: string, chunk: Buffer) =>
      buf.length >= OUTPUT_LIMIT ? buf : (buf + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT);
    child.stdout?.on("data", (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = cap(stderr, c);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err) => {
      stderr += String(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

export class NodePermissionSandbox implements Sandbox {
  readonly name = "node-permission";
  readonly runtimes = ["node"] as const;

  constructor(private readonly opts: { nodePath?: string; maxOldSpaceMb?: number } = {}) {}

  async run(p: { runtime: Runtime; files: SandboxFile[]; tests: string[]; timeoutMs: number }) {
    if (p.runtime !== "node") throw new Error(`${this.name} only runs node tests`);
    const dir = await writeWorkspace(p.files);
    try {
      return await runProcess(
        this.opts.nodePath ?? process.execPath,
        [
          "--permission",
          `--allow-fs-read=${dir}`,
          `--max-old-space-size=${this.opts.maxOldSpaceMb ?? 256}`,
          "--disable-proto=throw",
          ...testCommand("node", p.tests),
        ],
        // No inherited environment: deliverables must not see the server's secrets.
        { cwd: dir, env: { NODE_ENV: "test" }, timeoutMs: p.timeoutMs },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export interface DockerSandboxOptions {
  docker?: string;
  images?: Partial<Record<Runtime, string>>;
  /** e.g. "runsc" for gVisor. */
  ociRuntime?: string;
  memoryMb?: number;
  cpus?: number;
  /** Injectable for tests. */
  exec?: typeof runProcess;
}

export class DockerSandbox implements Sandbox {
  readonly name = "docker";
  readonly runtimes = ["node", "python"] as const;
  private readonly images: Record<Runtime, string>;

  constructor(private readonly opts: DockerSandboxOptions = {}) {
    this.images = {
      node: opts.images?.node ?? "node:24-alpine",
      python: opts.images?.python ?? "python:3.13-alpine",
    };
  }

  /** The full `docker run` argument list (exposed for tests and audits). */
  args(runtime: Runtime, dir: string, name: string, tests: string[]): string[] {
    return [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      `${this.opts.memoryMb ?? 512}m`,
      "--memory-swap",
      `${this.opts.memoryMb ?? 512}m`,
      "--cpus",
      String(this.opts.cpus ?? 1),
      "--pids-limit",
      "128",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      ...(this.opts.ociRuntime ? ["--runtime", this.opts.ociRuntime] : []),
      "-e",
      "HOME=/tmp",
      "-v",
      `${dir}:/work:ro`,
      "-w",
      "/work",
      this.images[runtime],
      runtime === "node" ? "node" : "python",
      ...testCommand(runtime, tests),
    ];
  }

  async run(p: { runtime: Runtime; files: SandboxFile[]; tests: string[]; timeoutMs: number }) {
    const docker = this.opts.docker ?? "docker";
    const exec = this.opts.exec ?? runProcess;
    const dir = await writeWorkspace(p.files);
    const name = `pd-sbx-${randomBytes(6).toString("hex")}`;
    try {
      return await exec(docker, this.args(p.runtime, dir, name, p.tests), {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: p.timeoutMs,
        onTimeout: () => {
          spawn(docker, ["kill", name], { stdio: "ignore" }).on("error", () => {});
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
