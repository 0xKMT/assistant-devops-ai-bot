/**
 * Creates local container configuration and secret placeholders without
 * overwriting existing operator values. Files containing credentials are kept
 * at mode 0600 and remain excluded from packaging.
 */
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { initializeContainerSecretFiles } from "./lib/container-secret-files.mjs";

// Phase 1: create operator-owned directories and copy editable examples only
// when their real local counterparts do not exist.
const root = path.resolve(process.env.FRIDAY_CONTAINER_INIT_ROOT || path.join(import.meta.dirname, ".."));
const containerDir = path.join(root, "container");
const secretsDir = path.join(containerDir, "secrets");
await mkdir(secretsDir, { recursive: true, mode: 0o700 });
await mkdir(path.join(containerDir, "backups"), { recursive: true, mode: 0o700 });

async function copyIfMissing(source, target, mode) {
  const exists = await readFile(target).then(() => true).catch(() => false);
  if (!exists) await copyFile(source, target);
  await chmod(target, mode);
}

await copyIfMissing(path.join(containerDir, ".env.example"), path.join(containerDir, ".env"), 0o600);
await copyIfMissing(
  path.join(root, "config", "instance.container.example.json"),
  path.join(root, "config", "instance.container.json"),
  0o600,
);

// Phase 2: generate a strong gateway token locally; Slack files are empty
// placeholders because their values must come from the operator/Slack console.
const gatewayPath = path.join(secretsDir, "gateway-token");
const gatewayExists = await readFile(gatewayPath, "utf8").then((value) => Boolean(value.trim())).catch(() => false);
if (!gatewayExists) await writeFile(gatewayPath, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });
const instance = JSON.parse(await readFile(path.join(root, "config", "instance.container.json"), "utf8"));
await initializeContainerSecretFiles(secretsDir, instance);

process.stdout.write([
  "Container files initialized.",
  "Edit container/.env and config/instance.container.json.",
  "Put one bot/app token pair and the Jira API token in the account-specific files under container/secrets/.",
  "Secret values were not printed.",
].join("\n") + "\n");
