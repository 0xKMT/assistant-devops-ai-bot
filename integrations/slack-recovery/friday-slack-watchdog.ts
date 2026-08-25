#!/usr/bin/env node

/**
 * Conservative macOS watchdog for Slack/OpenClaw recovery after wake or network
 * loss. It tails only new log bytes and applies DNS, cooldown and circuit-breaker
 * gates before restarting the launchd service.
 */
import { promises as fs } from "node:fs";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface WatchdogState {
  version: 1;
  logOffset: number;
  logInode: number | null;
  pendingReason: string | null;
  restartTimestamps: number[];
  lastActionAt: string | null;
}

const HOME = os.homedir();
const LOG_PATH = process.env.FRIDAY_WATCHDOG_GATEWAY_LOG
  ?? path.join(HOME, "Library/Logs/openclaw/gateway.log");
const STATE_PATH = process.env.FRIDAY_WATCHDOG_STATE
  ?? path.join(HOME, ".openclaw/state/friday-slack-watchdog.json");
const GATEWAY_LABEL = process.env.FRIDAY_WATCHDOG_GATEWAY_LABEL
  ?? "ai.openclaw.gateway";
const DRY_RUN = process.env.FRIDAY_WATCHDOG_DRY_RUN === "1";
const SKIP_NETWORK = process.env.FRIDAY_WATCHDOG_SKIP_NETWORK === "1";
const WINDOW_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 2;
const MAX_READ_BYTES = 512 * 1024;

const now = Date.now();

export function defaultState(): WatchdogState {
  return {
    version: 1,
    logOffset: 0,
    logInode: null,
    pendingReason: null,
    restartTimestamps: [],
    lastActionAt: null,
  };
}

async function readState(): Promise<WatchdogState> {
  try {
    return { ...defaultState(), ...JSON.parse(await fs.readFile(STATE_PATH, "utf8")) } as WatchdogState;
  } catch {
    return defaultState();
  }
}

async function writeState(state: WatchdogState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${STATE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, STATE_PATH);
}

/** Reduces new gateway log lines into a pending recovery reason. */
export function processGatewayLines(lines: readonly string[], state: WatchdogState): void {
  for (const line of lines) {
    if (
      line.includes("slack identity refreshed")
      || (line.includes("Inbound app_mention slack:") && !line.includes("slack::"))
    ) {
      state.pendingReason = null;
      continue;
    }
    if (line.includes("slack auth.test failed at boot")) {
      state.pendingReason = "auth-test-failed";
    } else if (line.includes("Inbound app_mention slack::")) {
      state.pendingReason = "blank-slack-identity";
    } else if (line.includes("missing_recipient_team_id")) {
      state.pendingReason = "missing-recipient-team";
    }
  }
}

async function consumeGatewayLog(state: WatchdogState, initializeOnly = false): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(LOG_PATH);
  } catch {
    return;
  }
  const inodeChanged = state.logInode !== null && state.logInode !== stat.ino;
  const truncated = stat.size < state.logOffset;
  if (initializeOnly || state.logInode === null) {
    state.logOffset = stat.size;
    state.logInode = stat.ino;
    return;
  }
  if (inodeChanged || truncated) state.logOffset = 0;
  const start = Math.max(state.logOffset, stat.size - MAX_READ_BYTES);
  if (stat.size > start) {
    const handle = await fs.open(LOG_PATH, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      processGatewayLines(buffer.toString("utf8").split(/\r?\n/), state);
    } finally {
      await handle.close();
    }
  }
  state.logOffset = stat.size;
  state.logInode = stat.ino;
}

async function networkReady(): Promise<boolean> {
  if (SKIP_NETWORK) return true;
  try {
    await Promise.race([
      dns.lookup("slack.com"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 5000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

function runLaunchctl(args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/bin/launchctl", [...args], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function gatewayRunning(uid: number): Promise<boolean> {
  return runLaunchctl(["print", `gui/${uid}/${GATEWAY_LABEL}`]);
}

async function restartGateway(uid: number): Promise<boolean> {
  if (DRY_RUN) return true;
  return runLaunchctl(["kickstart", "-k", `gui/${uid}/${GATEWAY_LABEL}`]);
}

/** Executes one watchdog cycle; launchd is responsible for periodic scheduling. */
export async function main(): Promise<void> {
  // Phase 1: consume only log bytes not processed in the previous cycle. The
  // initialize path records the current end without reacting to historical log.
  const initializeOnly = process.argv.includes("--initialize");
  const state = await readState();
  await consumeGatewayLog(state, initializeOnly);
  if (initializeOnly) {
    await writeState(state);
    console.log("watchdog initialized");
    return;
  }

  // Phase 2: prune the rolling restart window and decide whether a recovery
  // reason exists from either service state or parsed Slack failures.
  state.restartTimestamps = state.restartTimestamps
    .filter((timestamp) => now - timestamp < WINDOW_MS);

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Friday watchdog requires a Unix user ID.");
  const running = await gatewayRunning(uid);
  const reason = running ? state.pendingReason : "gateway-not-running";
  if (!reason) {
    await writeState(state);
    console.log("healthy");
    return;
  }
  // Phase 3: apply safety gates in order. Network, cooldown and circuit breaker
  // defer the reason in state so a later launchd cycle can retry safely.
  if (!(await networkReady())) {
    state.pendingReason = reason;
    await writeState(state);
    console.log(`deferred: network unavailable (${reason})`);
    return;
  }
  const lastRestart = state.restartTimestamps.at(-1) ?? 0;
  if (now - lastRestart < COOLDOWN_MS) {
    state.pendingReason = reason;
    await writeState(state);
    console.log(`deferred: cooldown (${reason})`);
    return;
  }
  if (state.restartTimestamps.length >= MAX_RESTARTS) {
    state.pendingReason = reason;
    await writeState(state);
    console.error(`circuit open: ${MAX_RESTARTS} restarts in 30 minutes (${reason})`);
    process.exitCode = 2;
    return;
  }

  // Phase 4: perform at most one restart in this cycle and persist the timestamp
  // before reporting success.
  const restarted = await restartGateway(uid);
  if (!restarted) {
    state.pendingReason = reason;
    await writeState(state);
    console.error(`restart failed (${reason})`);
    process.exitCode = 1;
    return;
  }
  state.restartTimestamps.push(now);
  state.lastActionAt = new Date(now).toISOString();
  state.pendingReason = null;
  await writeState(state);
  console.log(`${DRY_RUN ? "would restart" : "restarted"} gateway (${reason})`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
