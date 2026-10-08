import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NODE_RUNNER, PYTHON_RUNNER, RUNNER_DIR } from "./runner.ts";

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
  /** Set when the process couldn't be started at all. */
  spawnError?: string;
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
    /** One-time key the trusted runner signs results with; never visible to delivered code. */
    key: Buffer;
  }): Promise<SandboxRun>;
}

export const OUTPUT_LIMIT = 256 * 1024;

/**
 * The sandbox itself couldn't run (no Docker, daemon down, runtime missing). Never a verdict on
 * the delivery: the job stays in "verifying" and is retried.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}

/** Paths inside the workspace only: relative, no `..`, conservative characters. */
export function safePath(p: string): string | null {
  if (p.length === 0 || p.length > 200 || p.includes("\0") || p.includes("\\")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.length > 8 || parts.some((x) => x === "" || x === "." || x === "..")) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return null;
  return p;
}

/** The command that runs the trusted runner (see runner.ts) on the test files. */
export function testCommand(runtime: Runtime, tests: string[]): string[] {
  if (runtime === "node") return ["--frozen-intrinsics", `${RUNNER_DIR}/runner.mjs`, ...tests];
  return [`${RUNNER_DIR}/runner.py`, ...tests];
}

/** The runner script for a runtime, added to the workspace last so nothing can replace it. */
export function runnerFile(runtime: Runtime): SandboxFile {
  return runtime === "node"
    ? { path: `${RUNNER_DIR}/runner.mjs`, content: NODE_RUNNER }
    : { path: `${RUNNER_DIR}/runner.py`, content: PYTHON_RUNNER };
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
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onTimeout?: () => void;
    stdin?: Buffer;
  },
): Promise<SandboxRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        spawnError: String(err),
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
    let spawnError: string | undefined;
    child.on("error", (err) => {
      spawnError = String(err);
    });
    if (opts.stdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ...(spawnError ? { spawnError } : {}),
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

export class NodePermissionSandbox implements Sandbox {
  readonly name = "node-permission";
  readonly runtimes = ["node"] as const;

  constructor(private readonly opts: { nodePath?: string; maxOldSpaceMb?: number } = {}) {}

  async run(p: {
    runtime: Runtime;
    files: SandboxFile[];
    tests: string[];
    timeoutMs: number;
    key: Buffer;
  }) {
    if (p.runtime !== "node") throw new Error(`${this.name} only runs node tests`);
    const dir = await writeWorkspace([...p.files, runnerFile("node")]);
    try {
      const run = await runProcess(
        this.opts.nodePath ?? process.execPath,
        [
          "--permission",
          `--allow-fs-read=${dir}`,
          `--max-old-space-size=${this.opts.maxOldSpaceMb ?? 256}`,
          "--disable-proto=throw",
          ...testCommand("node", p.tests),
        ],
        // No inherited environment: deliverables must not see the server's secrets.
        // The key arrives on stdin, read by the runner before any delivered code loads.
        { cwd: dir, env: { NODE_ENV: "test" }, timeoutMs: p.timeoutMs, stdin: p.key },
      );
      if (run.spawnError)
        throw new SandboxUnavailableError(`couldn't start node: ${run.spawnError}`);
      return run;
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

  /**
   * The full `docker run` argument list (exposed for tests and audits). The workspace is piped
   * in as a tar archive and unpacked into a tmpfs, so nothing on the host is mounted and a
   * remote daemon (DOCKER_HOST=ssh://sandbox-host) works the same as a local one.
   */
  args(runtime: Runtime, name: string, tests: string[]): string[] {
    const cmd = [runtime === "node" ? "node" : "python", ...testCommand(runtime, tests)]
      .map(shellQuote)
      .join(" ");
    return [
      "run",
      "--rm",
      "-i",
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
      "--tmpfs",
      "/work:rw,nosuid,size=64m,uid=65534,gid=65534",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      ...(this.opts.ociRuntime ? ["--runtime", this.opts.ociRuntime] : []),
      "-e",
      "HOME=/tmp",
      "-e",
      "PD_KEY_SOURCE=file",
      "-w",
      "/work",
      this.images[runtime],
      "sh",
      "-c",
      `tar -x -C /work && exec ${cmd}`,
    ];
  }

  async run(p: {
    runtime: Runtime;
    files: SandboxFile[];
    tests: string[];
    timeoutMs: number;
    key: Buffer;
  }) {
    const docker = this.opts.docker ?? "docker";
    const exec = this.opts.exec ?? runProcess;
    const name = `pd-sbx-${randomBytes(6).toString("hex")}`;
    const run = await exec(docker, this.args(p.runtime, name, p.tests), {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
      timeoutMs: p.timeoutMs,
      // stdin carries the workspace; the key travels as a file the runner deletes on start.
      stdin: tarArchive([
        ...p.files,
        runnerFile(p.runtime),
        { path: `${RUNNER_DIR}/key`, content: p.key.toString("utf8") },
      ]),
      onTimeout: () => {
        spawn(docker, ["kill", name], { stdio: "ignore" }).on("error", () => {});
      },
    });
    // 125: docker itself failed (daemon unreachable, image pull failed); 126/127: the runtime
    // in the image couldn't be run. None of that says anything about the delivery.
    if (run.spawnError || (!run.timedOut && [125, 126, 127].includes(run.exitCode ?? -1))) {
      throw new SandboxUnavailableError(
        `docker sandbox unavailable: ${run.spawnError ?? run.stderr.slice(-300)}`,
      );
    }
    return run;
  }
}

const shellQuote = (s: string) =>
  /^[A-Za-z0-9_./=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

/** A minimal ustar archive (regular files, parent dirs created by tar -x). */
export function tarArchive(files: SandboxFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const path = safePath(f.path);
    if (!path) throw new Error(`unsafe path ${JSON.stringify(f.path)}`);
    const body = Buffer.from(f.content, "utf8");
    const header = Buffer.alloc(512);
    const field = (value: string, offset: number, length: number) =>
      header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
    const octal = (n: number, offset: number, length: number) =>
      field(`${n.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    field(path, 0, 100);
    octal(0o644, 100, 8);
    octal(65534, 108, 8);
    octal(65534, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(" ", 148, 156); // checksum placeholder
    field("0", 156, 1);
    field("ustar\0", 257, 6);
    field("00", 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
