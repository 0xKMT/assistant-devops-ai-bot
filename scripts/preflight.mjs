/**
 * Read-only host/instance validation performed before rendering or mutation.
 * Optional flags tighten the gate for authenticated/apply flows without ever
 * printing credential values.
 */
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { githubSlug } from "./lib/git-remote.mjs";
import { parseSlackAccounts } from "./lib/slack-accounts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = path.resolve(root, configIndex >= 0 ? args[configIndex + 1] ?? "" : "config/instance.json");
const requireSecrets = args.includes("--require-secrets");
const requireAuth = args.includes("--require-auth");
const jsonOutput = args.includes("--json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const openclawStateDir = String(config.paths?.openclawStateDir ?? "").trim();
const commandEnv = { ...process.env, ...(openclawStateDir ? { OPENCLAW_STATE_DIR: openclawStateDir } : {}) };
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function run(command, commandArgs = [], options = {}) {
  return spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", shell: false, env: commandEnv, ...options });
}

function authProfiles(result) {
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(String(result.stdout || "{}"));
    return Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function commandVersion(name, command, commandArgs = ["--version"]) {
  const result = run(command, commandArgs);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").at(-1) ?? "";
  record(name, result.status === 0, result.status === 0 ? output : "not available");
  return result.status === 0 ? output : "";
}

// Phase 1: verify platform and pinned runtime versions first; later checks may
// depend on these commands behaving as expected.
if (!new Set(["darwin", "linux"]).has(process.platform)) {
  record("platform", false, `${process.platform} is not supported by this kit`);
} else record("platform", true, process.platform);

const expectedNodeMajor = Number(config.runtime?.nodeMajor ?? 24);
const nodeMajor = Number(process.versions.node.split(".")[0]);
record("node", nodeMajor === expectedNodeMajor, `v${process.versions.node}; expected major ${expectedNodeMajor}`);
commandVersion("npm", "npm");
const openclawVersion = commandVersion("openclaw", "openclaw");
const expectedOpenclaw = String(config.runtime?.openclawVersion ?? "").trim();
if (expectedOpenclaw) {
  const containerRelease = String(config.container?.imageVersion ?? "").trim();
  const imageRelease = String(process.env.FRIDAY_OPENCLAW_IMAGE_VERSION ?? "").trim();
  const coreVersion = expectedOpenclaw.replace(/-\d+$/, "");
  const matches = openclawVersion.includes(expectedOpenclaw)
    || (containerRelease === expectedOpenclaw && imageRelease === containerRelease && openclawVersion.includes(coreVersion));
  record("openclaw-version-pin", matches, `expected ${expectedOpenclaw}${containerRelease ? ` (image ${containerRelease})` : ""}`);
}

// Phase 2: delegate full schema/path validation to the canonical generator,
// then independently verify configured executables and Git remotes on this host.
const configCheck = run(process.execPath, [path.join(root, "scripts", "prepare-instance.mjs"), "--check", "--config", configPath]);
record("instance-config", configCheck.status === 0, configCheck.status === 0 ? "valid" : `${configCheck.stderr ?? configCheck.stdout}`.trim());

for (const [name, executable] of Object.entries(config.binaries ?? {})) {
  const executablePath = String(executable ?? "");
  let ok = path.isAbsolute(executablePath);
  if (ok) ok = await access(executablePath, fsConstants.X_OK).then(() => true).catch(() => false);
  record(`binary:${name}`, ok, ok ? executablePath : "missing or not executable");
}

for (const repository of config.repositories ?? []) {
  const repositoryRoot = String(repository.root ?? "");
  const info = await stat(repositoryRoot).catch(() => null);
  const remote = info?.isDirectory()
    ? run(String(config.binaries?.git ?? "git"), ["-C", repositoryRoot, "remote", "get-url", "origin"])
    : { status: 1, stdout: "" };
  const actualRemote = String(remote.stdout ?? "").trim();
  const expectedSlug = String(repository.slug ?? "").toLowerCase();
  record(`repository:${repository.slug}`, remote.status === 0 && githubSlug(actualRemote) === expectedSlug,
    remote.status === 0 ? `origin=${actualRemote}` : "not a Git clone with origin");
}

// Phase 3: check read credentials and selected model backend. Auth profile
// details are reduced to counts/status and token values are never captured.
const ghStatus = run(String(config.binaries?.gh ?? "gh"), ["auth", "status"]);
record("github-auth", ghStatus.status === 0, ghStatus.status === 0 ? "authenticated" : "run: gh auth login");

const profile = String(config.modelBackend?.profile ?? "");
if (profile === "codex") {
  const codex = run("codex", ["--version"]);
  record("codex-cli-optional", true, codex.status === 0 ? String(codex.stdout).trim() : "not installed; OpenClaw OAuth is sufficient");
  if (requireAuth) {
    const auth = run("openclaw", ["models", "auth", "list", "--provider", "openai", "--json"]);
    const profiles = authProfiles(auth);
    record("codex-auth", profiles.length > 0,
      profiles.length > 0 ? `${profiles.length} OpenAI auth profile(s) available` : "run OpenClaw Codex login");
  }
} else if (profile === "claude-code") {
  commandVersion("claude-code", String(config.modelBackend?.command ?? "claude"));
  if (requireAuth) {
    const status = run(String(config.modelBackend?.command ?? "claude"), ["auth", "status", "--text"]);
    record("claude-auth", status.status === 0, status.status === 0 ? "authenticated" : "run: claude auth login");
    const auth = run("openclaw", ["models", "auth", "list", "--provider", "anthropic", "--json"]);
    const profiles = authProfiles(auth);
    record("openclaw-anthropic-auth", profiles.length > 0,
      profiles.length > 0 ? `${profiles.length} Anthropic auth profile(s) available` : "run full setup with --login");
  }
}

// Phase 4: apply flows can require secret presence, but only by configured
// environment-variable name; values are never added to the report.
for (const account of parseSlackAccounts(config.slack)) for (const envName of [account.botTokenEnv, account.appTokenEnv]) {
  if (requireSecrets) record(`secret-env:${envName}`, Boolean(envName && process.env[envName]), process.env[envName] ? "present" : "missing");
}
if (requireSecrets) {
  const jiraEmailEnv = String(config.jira?.emailEnv ?? "").trim();
  record(`secret-env:${jiraEmailEnv || "jira.emailEnv"}`, Boolean(jiraEmailEnv && process.env[jiraEmailEnv]),
    jiraEmailEnv && process.env[jiraEmailEnv] ? "present" : "missing");
  const jiraTokenEnv = String(config.jira?.apiTokenEnv ?? "").trim();
  record(`secret-env:${jiraTokenEnv || "jira.apiTokenEnv"}`, Boolean(jiraTokenEnv && process.env[jiraTokenEnv]),
    jiraTokenEnv && process.env[jiraTokenEnv] ? "present" : "missing");
}

// Phase 5: emit one stable report and a non-zero exit status if any gate failed.
const failed = checks.filter((check) => !check.ok);
if (jsonOutput) process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks }, null, 2)}\n`);
else {
  for (const check of checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  process.stdout.write(`\n${failed.length ? `${failed.length} preflight check(s) failed.` : "All preflight checks passed."}\n`);
}
if (failed.length) process.exitCode = 1;
