import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSlackAccounts, secretFileNames } from "./slack-accounts.mjs";

function jiraTokenEnv(instance) {
  const value = String(instance?.jira?.apiTokenEnv ?? "").trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error("jira.apiTokenEnv must be an environment variable name.");
  return value;
}

/** Ensures configured credential files exist and are owner-readable only. */
export async function initializeContainerSecretFiles(secretsDir, instance) {
  parseSlackAccounts(instance?.slack);
  jiraTokenEnv(instance);
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const names = [
    ...parseSlackAccounts(instance.slack).flatMap((account) => Object.values(secretFileNames(account))),
    "jira-api-token",
  ];
  for (const name of names) {
    const target = path.join(secretsDir, name);
    const exists = await readFile(target).then(() => true).catch(() => false);
    if (!exists) await writeFile(target, "", { mode: 0o600 });
    await chmod(target, 0o600);
  }
}
