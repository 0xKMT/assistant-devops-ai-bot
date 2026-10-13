/**
 * Friday-managed Codex native configuration. OpenClaw's codex plugin schema
 * cannot disable Codex-native shell or app surfaces, so they are switched off
 * in the per-agent CODEX_HOME config.toml that the Codex app-server reads.
 * OpenClaw does not set these feature keys in its thread config.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CODEX_HOME_MANAGED_HEADER = "# Managed by Friday (scripts/prepare-instance.mjs). Only [projects.*] tables are preserved.";

export const CODEX_HOME_LOCKDOWN_TOML = [
  CODEX_HOME_MANAGED_HEADER,
  'approval_policy = "never"',
  'sandbox_mode = "read-only"',
  'web_search = "disabled"',
  "",
  "[features]",
  "shell_tool = false",
  "unified_exec = false",
  "apps = false",
  "browser_use = false",
  "in_app_browser = false",
  "computer_use = false",
  "image_generation = false",
  "multi_agent = false",
  "",
].join("\n");

const PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*"((?:[^"\\\n]|\\.)*)"\s*\]\s*(?:#.*)?$/;
const TRUST_LEVEL = /^\s*trust_level\s*=\s*"(trusted|untrusted)"\s*(?:#.*)?$/;

/**
 * Rebuilds only OpenClaw-written project trust entries from the existing file
 * (`[projects."<path>"]` with a validated trust_level); every other table and
 * key is dropped, so stale overrides, MCP servers or profiles cannot survive.
 * The managed lockdown always comes first.
 */
export function mergeCodexHomeConfig(existingText, managedText = CODEX_HOME_LOCKDOWN_TOML) {
  const trust = new Map();
  let project;
  for (const line of String(existingText ?? "").split("\n")) {
    if (/^\s*\[/.test(line)) {
      project = line.match(PROJECT_HEADER)?.[1];
      continue;
    }
    const level = project === undefined ? undefined : line.match(TRUST_LEVEL)?.[1];
    if (level) trust.set(project, level);
  }
  const tables = [...trust].map(([projectPath, level]) => `[projects."${projectPath}"]\ntrust_level = "${level}"`);
  return [managedText.trimEnd(), ...tables].join("\n\n") + "\n";
}

export function codexHomeConfigPath(stateDir, agentId = "main") {
  return path.join(stateDir, "agents", agentId, "agent", "codex-home", "config.toml");
}

/** Installs the managed file atomically with owner-only permissions. */
export async function installCodexHomeConfig({ stateDir, managedPath, agentId = "main" }) {
  const managedText = await readFile(managedPath, "utf8");
  const target = codexHomeConfigPath(stateDir, agentId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = await readFile(target, "utf8").catch(() => "");
  const temporaryPath = `${target}.friday-${process.pid}`;
  await writeFile(temporaryPath, mergeCodexHomeConfig(existing, managedText), { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, target);
  return target;
}
