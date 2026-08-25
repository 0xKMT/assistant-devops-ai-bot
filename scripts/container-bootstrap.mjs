/**
 * Applies a generated Friday instance inside the container's persistent state
 * volume. Dry-run is the default; plugin/config/workspace mutations require the
 * explicit --apply flag and successful preflight checks.
 */
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = path.resolve(configIndex >= 0 ? args[configIndex + 1] ?? "" : "/opt/friday/config/instance.json");
const apply = args.includes("--apply");
const config = JSON.parse(await readFile(configPath, "utf8"));
const stateDir = path.resolve(String(config.paths?.openclawStateDir ?? "/home/node/.openclaw"));
const workspaceDir = path.resolve(String(config.paths?.workspace ?? path.join(stateDir, "workspace")));
const buildDir = path.join(stateDir, "friday-build");
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, FRIDAY_BUILD_DIR: buildDir };

function run(command, commandArgs = []) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with status ${result.status}.`);
}

// Phase 1: validate, render into the persistent state volume and ask OpenClaw to
// dry-run the patch. These steps are safe for both preview and apply paths.
run(process.execPath, [path.join(sourceRoot, "scripts", "prepare-instance.mjs"), "--check", "--config", configPath]);
run(process.execPath, [path.join(sourceRoot, "scripts", "prepare-instance.mjs"), "--config", configPath]);
const basePatch = path.join(buildDir, "openclaw.patch.json");
// The generated instance is authoritative for Slack accounts.  A normal
// object patch merges maps and would retain deleted accounts plus their stale
// secret references, so replace this map atomically on every apply.
const configPatchArgs = [
  "config", "patch", "--file", basePatch,
  "--replace-path", "channels.slack.accounts",
  "--replace-path", "plugins.entries.friday-jira-adapter.config.jira",
];

// Old Jira adapter versions already require storyPointFieldId. Add that one
// deterministic configured value before OpenClaw loads the old extension, so
// a normal `--apply` can upgrade an otherwise-invalid persisted config.
async function migrateLegacyJiraConfig() {
  const stateConfigPath = path.join(stateDir, "openclaw.json");
  const [currentText, patchText] = await Promise.all([
    readFile(stateConfigPath, "utf8").catch(() => null),
    readFile(basePatch, "utf8"),
  ]);
  if (!currentText) return;
  const current = JSON.parse(currentText);
  const target = JSON.parse(patchText);
  const jira = current?.plugins?.entries?.["friday-jira-adapter"]?.config?.jira;
  const targetField = target?.plugins?.entries?.["friday-jira-adapter"]?.config?.jira?.storyPointFieldId;
  if (!jira || typeof jira !== "object" || typeof targetField !== "string" || jira.storyPointFieldId !== undefined) return;
  jira.storyPointFieldId = targetField;
  const temporaryPath = `${stateConfigPath}.friday-migrate-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, stateConfigPath);
}

// Preview stops here; no plugin installation or active config/workspace write.
if (!apply) {
  run("openclaw", [...configPatchArgs, "--dry-run"]);
  process.stdout.write("Container dry-run passed; no plugin, config, or workspace was changed.\n");
  process.exit(0);
}

// Phase 2: apply requires both authenticated model state and mounted secrets.
run(process.execPath, [
  path.join(sourceRoot, "scripts", "preflight.mjs"),
  "--config", configPath,
  "--require-auth",
  "--require-secrets",
]);

// Phase 3: install tested local bundles before validating their configuration.
// A newer plugin schema can legitimately introduce a required field that the
// previously installed extension does not yet know about.

await migrateLegacyJiraConfig();

for (const pluginPath of [
  path.join(sourceRoot, "integrations/git-adapter"),
  path.join(sourceRoot, "integrations/jira-adapter"),
  path.join(sourceRoot, "core/security-shield"),
]) {
  await access(path.join(pluginPath, "dist", "index.js"));
  run("openclaw", ["plugins", "install", "--force", pluginPath]);
}
run("openclaw", [...configPatchArgs, "--dry-run"]);
run("openclaw", configPatchArgs);

// Phase 4: copy only generated workspace files into persistent state and lock
// permissions before running final runtime health checks.
const generatedWorkspace = path.join(buildDir, "workspace");
await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
for (const file of await readdir(generatedWorkspace)) {
  await copyFile(path.join(generatedWorkspace, file), path.join(workspaceDir, file));
  await chmod(path.join(workspaceDir, file), 0o600);
}

run("openclaw", ["config", "validate"]);
run("openclaw", ["plugins", "doctor"]);
run("openclaw", ["models", "status", "--check"]);
process.stdout.write("Friday container configuration applied and validated.\n");
