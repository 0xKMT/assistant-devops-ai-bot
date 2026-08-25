/**
 * Restores one explicitly named native-host backup. Automatic "latest" lookup
 * is intentionally forbidden so rollback cannot select an unintended snapshot.
 */
import { access, copyFile, cp, glob, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const backupIndex = args.indexOf("--backup");
const configIndex = args.indexOf("--config");
const backupDir = path.resolve(root, backupIndex >= 0 ? args[backupIndex + 1] ?? "" : "");
const configPath = path.resolve(root, configIndex >= 0 ? args[configIndex + 1] ?? "" : "config/instance.json");
const apply = args.includes("--apply");

if (backupIndex < 0 || !args[backupIndex + 1]) {
  throw new Error("Pass the exact backup directory with --backup. Automatic backup selection is intentionally disabled.");
}

// Phase 1: derive exact restore targets from the selected backup and active
// instance paths. Missing artifact types are skipped rather than fabricated.
const config = JSON.parse(await readFile(configPath, "utf8"));
const stateDir = path.resolve(String(config.paths?.openclawStateDir ?? ""));
const workspaceDir = path.resolve(String(config.paths?.workspace ?? ""));
const configBackup = path.join(backupDir, "openclaw.json.backup");
const envBackup = path.join(backupDir, "openclaw.env.backup");
const workspaceBackup = path.join(backupDir, "workspace");
const slackBackup = path.join(backupDir, "slack-compat", "dist");
const targets = [];

if (await access(configBackup).then(() => true).catch(() => false)) {
  targets.push([configBackup, path.join(stateDir, "openclaw.json"), "file"]);
}
if (await access(envBackup).then(() => true).catch(() => false)) {
  targets.push([envBackup, path.join(stateDir, ".env"), "file"]);
}
if (await access(workspaceBackup).then(() => true).catch(() => false)) {
  targets.push([workspaceBackup, workspaceDir, "directory"]);
}
if (await access(slackBackup).then(() => true).catch(() => false)) {
  const pluginRoots = [];
  for await (const entry of glob(path.join(stateDir, "npm/projects/*/node_modules/@openclaw/slack"))) pluginRoots.push(entry);
  if (pluginRoots.length !== 1) throw new Error(`Cannot resolve one Slack plugin for rollback; found ${pluginRoots.length}.`);
  for await (const source of glob(path.join(slackBackup, "*.js"))) {
    targets.push([source, path.join(pluginRoots[0], "dist", path.basename(source)), "file"]);
  }
}
if (!targets.length) throw new Error(`No restorable artifacts found in ${backupDir}.`);

// Phase 2: print the complete source-to-target plan before the apply boundary.
for (const [source, target, kind] of targets) process.stdout.write(`${kind}: ${source} -> ${target}\n`);
if (!apply) {
  process.stdout.write("\nRollback plan only; no file was changed. Add --apply after reviewing these exact paths.\n");
  process.exit(0);
}

// Phase 3: restore only artifacts that existed in this backup; rollback does not
// delete newer unrelated files from the target instance.
for (const [source, target, kind] of targets) {
  if (kind === "directory") await cp(source, target, { recursive: true, force: true });
  else await copyFile(source, target);
}

// Phase 4: request a restart after all copies complete. A failed restart is
// surfaced without attempting another destructive recovery automatically.
const result = spawnSync("openclaw", ["gateway", "restart"], {
  stdio: "inherit",
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  shell: false,
});
if (result.status !== 0) throw new Error("Files were restored, but OpenClaw gateway restart failed. Run it manually after diagnosis.");
process.stdout.write("Rollback artifacts restored and gateway restart requested. Run acceptance checks again.\n");
