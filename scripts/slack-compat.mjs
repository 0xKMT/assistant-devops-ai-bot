#!/usr/bin/env node
/**
 * Locates @openclaw/slack 2026.7.1, verifies its package and bundle hashes, and
 * applies Friday's two minimal compatibility transforms. Check mode is
 * read-only. Apply mode writes backups before atomic, hash-verified replacement.
 */
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "node:fs/promises";
import { patchIdentityRefresh, patchRunIdPropagation } from "../compat/slack/patches.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "compat/slack/manifest.json"), "utf8"));
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const jsonOutput = args.includes("--json");
const allowMissing = args.includes("--allow-missing");
const noBackup = args.includes("--no-backup");

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function isDirectory(candidate) {
  return stat(candidate).then((value) => value.isDirectory()).catch(() => false);
}

async function resolvePluginRoot() {
  const explicit = option("--plugin-root");
  if (explicit) return path.resolve(explicit);

  const stateDir = path.resolve(option("--state-dir") ?? process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "", ".openclaw"));
  const matches = [];
  for await (const entry of glob(path.join(stateDir, "npm/projects/*/node_modules/@openclaw/slack"))) {
    if (await isDirectory(entry)) matches.push(entry);
  }
  if (matches.length !== 1) {
    if (allowMissing && matches.length === 0) return null;
    throw new Error(`Expected exactly one installed @openclaw/slack under ${stateDir}; found ${matches.length}. Pass --plugin-root explicitly.`);
  }
  return matches[0];
}

const flows = [
  ["runIdPropagation", patchRunIdPropagation],
  ["identityRefresh", patchIdentityRefresh],
];

const pluginRoot = await resolvePluginRoot();
if (!pluginRoot) {
  const report = { ok: true, mode: apply ? "apply" : "check", patchSet: manifest.patchSet, state: "not-installed" };
  process.stdout.write(jsonOutput ? `${JSON.stringify(report, null, 2)}\n` : "SKIP Slack compatibility: plugin is not installed yet; apply will install and verify the pinned package.\n");
  process.exit(0);
}
const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) {
  throw new Error(`Unsupported Slack package ${packageJson.name}@${packageJson.version}; expected ${manifest.package}@${manifest.version}.`);
}

const prepared = [];
for (const [name, transform] of flows) {
  const spec = manifest.flows[name];
  const file = path.join(pluginRoot, spec.file);
  const before = await readFile(file);
  const beforeHash = sha256(before);
  if (beforeHash !== spec.beforeSha256 && beforeHash !== spec.afterSha256) {
    throw new Error(`${name}: unsupported source hash ${beforeHash} for ${spec.file}; refusing to patch unknown vendor code.`);
  }
  const result = transform(before.toString("utf8"));
  const after = Buffer.from(result.source);
  const afterHash = sha256(after);
  if (afterHash !== spec.afterSha256) {
    throw new Error(`${name}: transformed hash ${afterHash} does not match manifest ${spec.afterSha256}.`);
  }
  prepared.push({ name, file, relativeFile: spec.file, before, after, state: beforeHash === spec.afterSha256 ? "already-patched" : result.state, afterHash });
}

let backupDir;
if (apply && prepared.some((item) => item.state === "patched")) {
  if (!noBackup) {
    backupDir = path.resolve(option("--backup-dir") ?? path.join(path.dirname(pluginRoot), `.friday-compat-backup-${manifest.patchSet}`));
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
  }

  // All flows are validated before the first write. Each original is backed up,
  // then a same-directory temporary file is atomically renamed into place.
  for (const item of prepared.filter((entry) => entry.state === "patched")) {
    if (backupDir) {
      const backupFile = path.join(backupDir, item.relativeFile);
      await mkdir(path.dirname(backupFile), { recursive: true, mode: 0o700 });
      await access(backupFile).catch(() => copyFile(item.file, backupFile));
    }
    const temporary = `${item.file}.friday-compat-tmp`;
    await writeFile(temporary, item.after, { mode: 0o644 });
    await rename(temporary, item.file);
  }
}

const report = {
  ok: true,
  mode: apply ? "apply" : "check",
  patchSet: manifest.patchSet,
  package: `${packageJson.name}@${packageJson.version}`,
  pluginRoot,
  ...(backupDir ? { backupDir } : {}),
  flows: prepared.map(({ name, relativeFile, state, afterHash }) => ({ name, file: relativeFile, state, sha256: afterHash })),
};
if (jsonOutput) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  for (const flow of report.flows) process.stdout.write(`${apply ? "PASS" : "CHECK"} ${flow.name}: ${flow.state} (${flow.file})\n`);
  process.stdout.write(`${apply ? "Slack compatibility patch set is applied." : "Slack compatibility patch set is applicable and verified."}\n`);
}
