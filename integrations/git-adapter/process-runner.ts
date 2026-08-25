/**
 * Bounded child-process runner shared by review engines.
 * Commands are executed directly (never through a shell) with explicit cwd,
 * environment, timeout and combined-output limits.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { reviewRuntime } from "./runtime-config.js";

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface ProcessRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly rejectOnFailure?: boolean;
  readonly redactError?: (value: string) => string;
}

export interface CommandRunner {
  run(request: ProcessRequest): Promise<ProcessOutput>;
}

function append(chunks: Buffer[], chunk: Buffer | string, state: { bytes: number; truncated: boolean }, limit: number): void {
  if (state.bytes >= limit) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = limit - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) state.truncated = true;
}

/** Production implementation; the interface allows deterministic test doubles. */
export class NodeCommandRunner implements CommandRunner {
  run(request: ProcessRequest): Promise<ProcessOutput> {
    return new Promise((resolve, reject) => {
      // Phase 1: allocate separate bounded stdout/stderr collectors and load the
      // validated process environment from runtime configuration.
      const startedAt = Date.now();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { bytes: 0, truncated: false };
      const stderrState = { bytes: 0, truncated: false };
      let timedOut = false;
      let settled = false;
      const runtime = reviewRuntime();
      const options: SpawnOptions = {
        ...(request.cwd ? { cwd: request.cwd } : {}), shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: runtime.process.path, HOME: runtime.process.home,
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? "", GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8", NO_COLOR: "1", KUBECONFIG: "/dev/null",
          ...request.env,
        },
      };
      // Phase 2: spawn the exact binary/argv without a shell. The model cannot
      // inject operators, redirections or environment expansion.
      const child = spawn(request.file, [...request.args], options);
      const finish = (exitCode: number | null, error = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) append(stderr, error, stderrState, request.maxBytes);
        const result: ProcessOutput = {
          stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode, timedOut, truncated: stdoutState.truncated || stderrState.truncated,
          durationMs: Date.now() - startedAt,
        };
        if (request.rejectOnFailure && exitCode !== 0) {
          const detail = request.redactError?.(result.stderr || result.stdout) ?? (result.stderr || result.stdout);
          reject(new Error(`${request.file} failed (${timedOut ? "timeout" : `exit ${exitCode}`}): ${detail.slice(0, 4000)}`));
        } else resolve(result);
      };
      // Phase 3: enforce timeout and byte caps while converging every exit/error
      // path through finish(), which settles the promise exactly once.
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, request.timeoutMs);
      child.stdout?.on("data", (chunk) => append(stdout, chunk, stdoutState, request.maxBytes));
      child.stderr?.on("data", (chunk) => append(stderr, chunk, stderrState, request.maxBytes));
      child.on("error", (error) => finish(null, error.message));
      child.on("close", (code) => finish(code));
    });
  }
}

export const commandRunner: CommandRunner = new NodeCommandRunner();
