/**
 * Native-host setup orchestrator. The normal path validates and renders only;
 * login, secret persistence, OpenClaw mutation and service restart each require
 * explicit command-line flags, with backup created before apply.
 */
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseSlackAccounts } from "./lib/slack-accounts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = path.resolve(root, configIndex >= 0 ? args[configIndex + 1] ?? "" : "config/instance.json");
const login = args.includes("--login");
const apply = args.includes("--apply");
const writeEnv = args.includes("--write-env");
const start = args.includes("--start");
const skipTests = args.includes("--skip-tests");
const config = JSON.parse(await readFile(configPath, "utf8"));
const stateDir = path.resolve(String(config.paths?.openclawStateDir ?? ""));
const workspaceDir = path.resolve(String(config.paths?.workspace ?? ""));
const commandEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

function run(command, commandArgs = [], options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    env: commandEnv,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with status ${result.status}.`);
  return options.capture ? String(result.stdout ?? "").trim() : "";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Replaces only configured Slack/Jira secret variables and preserves other entries. */
async function writeGatewayEnvironment(backupDir) {
  const names = parseSlackAccounts(config.slack)
    .flatMap((account) => [account.botTokenEnv, account.appTokenEnv]);
  names.push(String(config.jira?.apiTokenEnv ?? "").trim());
  const pairs = names.map((name) => [name, process.env[name]]);
  for (const [name, value] of pairs) {
    if (!name || !value) throw new Error(`Missing required secret environment variable: ${name || "<unnamed>"}`);
    if (value.includes("\n") || value.includes("\r")) throw new Error(`${name} contains a newline and cannot be written safely.`);
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const envPath = path.join(stateDir, ".env");
  const existing = await readFile(envPath, "utf8").catch(() => "");
  if (existing) {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await copyFile(envPath, path.join(backupDir, "openclaw.env.backup"));
    await chmod(path.join(backupDir, "openclaw.env.backup"), 0o600);
  }
  const filtered = existing.split("\n").filter((line) => !pairs.some(([name]) => line.startsWith(`${name}=`)));
  while (filtered.at(-1) === "") filtered.pop();
  const next = [...filtered, ...pairs.map(([name, value]) => `${name}=${value}`), ""].join("\n");
  await writeFile(envPath, next, { mode: 0o600 });
  await chmod(envPath, 0o600);
  process.stdout.write(`Gateway environment updated at ${envPath}; secret values were not printed.\n`);
}

/** Captures the exact config/workspace that rollback can restore later. */
async function backupCurrentState() {
  const backupDir = path.join(root, "build", "backups", timestamp());
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const activeConfig = run("openclaw", ["config", "file"], { capture: true }).split("\n").at(-1);
  if (activeConfig) {
    await access(activeConfig).then(async () => {
      await copyFile(activeConfig, path.join(backupDir, "openclaw.json.backup"));
      await chmod(path.join(backupDir, "openclaw.json.backup"), 0o600);
    }).catch(() => {});
  }
  await access(workspaceDir).then(async () => {
    await cp(workspaceDir, path.join(backupDir, "workspace"), { recursive: true, force: false });
  }).catch(() => {});
  process.stdout.write(`Backup prepared at ${backupDir}.\n`);
  return backupDir;
}

async function installWorkspace() {
  const generated = path.join(root, "build", "workspace");
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  for (const file of await readdir(generated)) {
    await copyFile(path.join(generated, file), path.join(workspaceDir, file));
    await chmod(path.join(workspaceDir, file), 0o600);
  }
  process.stdout.write(`Friday workspace installed at ${workspaceDir}.\n`);
}

// Phase 1: validate host binaries, paths and instance shape before any optional
// login or mutation is attempted.
run(process.execPath, [path.join(root, "scripts", "preflight.mjs"), "--config", configPath]);

// Phase 2 (optional): authenticate only the selected backend and verify the
// resulting model route. This is the only phase allowed to open login prompts.
if (login) {
  if (config.modelBackend.profile === "codex") {
    run("openclaw", ["plugins", "enable", "openai"]);
    run("openclaw", ["models", "auth", "login", "--provider", "openai", "--set-default"]);
  } else {
    const claude = String(config.modelBackend.command);
    const authStatus = spawnSync(claude, ["auth", "status", "--text"], { stdio: "ignore", env: commandEnv, shell: false });
    if (authStatus.status !== 0) run(claude, ["auth", "login"]);
    run("openclaw", ["plugins", "enable", "anthropic"]);
    run("openclaw", ["models", "auth", "login", "--provider", "anthropic", "--method", "cli", "--set-default"]);
  }
  run("openclaw", ["models", "set", String(config.modelBackend.primaryModel)]);
  run("openclaw", ["models", "status", "--check"]);
}

// Phase 3: reproduce dependencies, run regression gates, then render artifacts
// for review. Rendering still does not modify the active OpenClaw instance.
await access(path.join(root, "node_modules")).catch(() => run("npm", ["ci"]));
if (!skipTests) run("npm", ["test"]);
run(process.execPath, [path.join(root, "scripts", "prepare-instance.mjs"), "--config", configPath]);
run(process.execPath, [path.join(root, "scripts", "slack-compat.mjs"), "--state-dir", stateDir, "--allow-missing"]);

// Dry-run is the default terminal state. The operator must rerun with --apply
// after inspecting the generated patch and workspace.
if (!apply) {
  process.stdout.write([
    "\nDry preparation completed; no Friday plugin/workspace, Slack config, gateway service, or secret file was changed.",
    ...(login ? ["Model login/default was updated because --login was explicitly requested."] : ["OpenClaw model auth/default was not changed."]),
    `Backend: ${config.modelBackend.profile} (${config.modelBackend.primaryModel})`,
    "Run again with --login --apply --write-env --start after reviewing build/openclaw.patch.json.",
  ].join("\n") + "\n");
  process.exit(0);
}

// Phase 4: tighten preflight for apply, back up the exact current state and only
// then persist explicitly requested secret environment entries.
run(process.execPath, [
  path.join(root, "scripts", "preflight.mjs"),
  "--config", configPath,
  "--require-auth",
  ...(writeEnv ? ["--require-secrets"] : []),
]);
const backupDir = await backupCurrentState();
if (writeEnv) await writeGatewayEnvironment(backupDir);
// Install the exact Slack release before applying compatibility transforms.
// --force also restores pristine upstream bytes on a repeated setup run.
run("openclaw", ["plugins", "install", "--force", "npm:@openclaw/slack@2026.7.1"]);
// Patch only the two hash-pinned Slack bundles. The compatibility command
// creates its own vendor-file backup inside the same rollback snapshot.
run(process.execPath, [
  path.join(root, "scripts", "slack-compat.mjs"),
  "--state-dir", stateDir,
  "--backup-dir", path.join(backupDir, "slack-compat"),
  "--apply",
]);
// Phase 5: build/install local plugins, validate the patch in OpenClaw, apply it
// and copy the generated workspace with owner-only permissions.
run(process.execPath, [path.join(root, "scripts", "install-plugins.mjs")]);
run("openclaw", ["config", "patch", "--file", path.join(root, "build", "openclaw.patch.json"), "--dry-run"]);
run("openclaw", ["config", "patch", "--file", path.join(root, "build", "openclaw.patch.json")]);
await installWorkspace();
run("openclaw", ["config", "validate"]);
run("openclaw", ["plugins", "doctor"]);
run("openclaw", ["models", "list", "--provider", config.modelBackend.profile === "codex" ? "openai" : "anthropic"]);

// Phase 6 (optional): service mutation is separate from config apply so hosts
// with another service manager can omit it safely.
if (start) {
  run("openclaw", ["gateway", "install", "--force"]);
  run("openclaw", ["gateway", "restart"]);
  run("openclaw", ["gateway", "status"]);
  run("openclaw", ["channels", "status", "--deep"]);
}

process.stdout.write("\nFriday full setup completed. Run the manual acceptance matrix before declaring the instance production-ready.\n");
