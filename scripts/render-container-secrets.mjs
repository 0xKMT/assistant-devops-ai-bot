import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dockerSecretStem, parseSlackAccounts, secretFileNames } from "./lib/slack-accounts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return path.resolve(root, index < 0 ? fallback : args[index + 1] ?? ""); };
const configPath = option("--config", "config/instance.container.json");
const outputPath = option("--output", "build/container-secrets.compose.yaml");
const instance = JSON.parse(await readFile(configPath, "utf8"));
const accounts = parseSlackAccounts(instance.slack);
const jiraTokenEnv = String(instance.jira?.apiTokenEnv ?? "").trim();
if (!/^[A-Z_][A-Z0-9_]*$/.test(jiraTokenEnv)) throw new Error("jira.apiTokenEnv must be an environment variable name.");
const jiraSecret = { name: "friday_jira_api_token", file: "jira-api-token" };

// Apply flows use this flag to prove that every configured secret file exists
// and has content. We inspect only file metadata; credentials are never read.
if (args.includes("--require-files")) {
  for (const account of accounts) for (const file of Object.values(secretFileNames(account))) {
    const secretPath = path.join(root, "container", "secrets", file);
    const secret = await stat(secretPath).catch(() => null);
    if (!secret?.isFile() || secret.size === 0) {
      throw new Error(`Missing secret value: container/secrets/${file}`);
    }
  }
  const jiraPath = path.join(root, "container", "secrets", jiraSecret.file);
  const jiraFile = await stat(jiraPath).catch(() => null);
  if (!jiraFile?.isFile() || jiraFile.size === 0) throw new Error(`Missing secret value: container/secrets/${jiraSecret.file}`);
}

const lines = ["services:"];
for (const service of ["friday-gateway", "friday-cli"]) {
  lines.push(`  ${service}:`, "    secrets:");
  for (const account of accounts) for (const kind of ["bot", "app"]) {
    const name = `friday_slack_${dockerSecretStem(account.accountId)}_${kind}_token`;
    lines.push(`      - source: ${name}`, `        target: ${name}`);
  }
  lines.push(`      - source: ${jiraSecret.name}`, `        target: ${jiraSecret.name}`);
}
lines.push("secrets:");
for (const account of accounts) {
  const files = secretFileNames(account);
  for (const [kind, file] of Object.entries(files)) lines.push(`  friday_slack_${dockerSecretStem(account.accountId)}_${kind}_token:`, `    file: ./container/secrets/${file}`);
}
lines.push(`  ${jiraSecret.name}:`, `    file: ./container/secrets/${jiraSecret.file}`);
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${lines.join("\n")}\n`, { mode: 0o600 });
process.stdout.write(`Rendered account secret mapping for ${accounts.length} Slack account(s).\n`);
