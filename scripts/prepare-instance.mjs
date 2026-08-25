/**
 * Validates portable instance configuration and renders OpenClaw/workspace
 * artifacts. --check performs validation only; generated output is written to
 * build/ or FRIDAY_BUILD_DIR and never directly to the active runtime.
 */
import { access, mkdir, readFile, stat, writeFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { parseSlackAccounts } from "./lib/slack-accounts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const configIndex = args.indexOf("--config");
const configPath = path.resolve(root, configIndex >= 0 ? args[configIndex + 1] ?? "" : "config/instance.json");
const buildDir = path.resolve(process.env.FRIDAY_BUILD_DIR || path.join(root, "build"));

function fail(message) {
  throw new Error(message);
}

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`${label} is required.`);
  return normalized;
}

function absolute(value, label) {
  const normalized = text(value, label);
  if (!path.isAbsolute(normalized) || normalized.includes("/absolute/path/")) {
    fail(`${label} must be a real absolute path.`);
  }
  return normalized;
}

async function assertDirectory(value, label) {
  const info = await stat(value).catch(() => null);
  if (!info?.isDirectory()) fail(`${label} does not exist or is not a directory: ${value}`);
}

async function assertExecutable(value, label) {
  await access(value, fsConstants.X_OK).catch(() => fail(`${label} is not executable: ${value}`));
}

// Phase 1: split the user document into bounded sections; every value used
// below is normalized again rather than trusted from JSON parsing alone.
const config = JSON.parse(await readFile(configPath, "utf8"));
const assistant = config.assistant ?? {};
const modelBackend = config.modelBackend ?? {};
const slack = config.slack ?? {};
const paths = config.paths ?? {};
const container = config.container ?? null;
const repositories = Array.isArray(config.repositories) ? config.repositories : [];
const binaries = config.binaries ?? {};

// Phase 2: validate identity and backend routing. Provider prefixes prevent a
// profile from silently selecting a model served by a different runtime.
const assistantName = text(assistant.name, "assistant.name");
const ownerEmail = text(assistant.ownerEmail, "assistant.ownerEmail").toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail) || ownerEmail === "owner@example.com") {
  fail("assistant.ownerEmail must be the real administrative owner email.");
}
const language = text(assistant.language, "assistant.language");
const timezone = text(assistant.timezone, "assistant.timezone");

const backendProfile = text(modelBackend.profile, "modelBackend.profile");
if (!new Set(["codex", "claude-code"]).has(backendProfile)) {
  fail("modelBackend.profile must be codex or claude-code.");
}
const primaryModel = text(modelBackend.primaryModel, "modelBackend.primaryModel");
const expectedModelPrefix = backendProfile === "codex" ? "openai/" : "anthropic/";
if (!primaryModel.startsWith(expectedModelPrefix) || primaryModel.includes("example")) {
  fail(`modelBackend.primaryModel must use the ${expectedModelPrefix} provider route.`);
}
// The optional model list is ordered: primary remains authoritative and each
// later entry becomes a runtime fallback for transient capacity/rate failures.
// Older instance files that omit it stay compatible with primary-only routing.
const configuredModels = Array.isArray(modelBackend.availableModels)
  ? modelBackend.availableModels.map((model, index) => text(model, `modelBackend.availableModels[${index}]`))
  : [primaryModel];
if (!configuredModels.includes(primaryModel)) {
  fail("modelBackend.availableModels must include modelBackend.primaryModel.");
}
if (new Set(configuredModels).size !== configuredModels.length) {
  fail("modelBackend.availableModels must not contain duplicates.");
}
for (const model of configuredModels) {
  if (!model.startsWith(expectedModelPrefix) || model.includes("example")) {
    fail(`Every modelBackend.availableModels entry must use the ${expectedModelPrefix} provider route.`);
  }
}
const fallbackModels = configuredModels.filter((model) => model !== primaryModel);
let backendCommand = "";
if (backendProfile === "claude-code") {
  backendCommand = absolute(modelBackend.command, "modelBackend.command");
  await assertExecutable(backendCommand, "modelBackend.command");
}

// Phase 3: validate the exact Slack account/workspace/channel/user tuple and
// environment-variable names without reading any token value.
const slackAccounts = parseSlackAccounts(slack);

// Phase 3b: Jira stays a single, explicitly bound destination in this
// instance. The portable configuration carries identifiers and environment
// variable names only; token values are resolved later by the runtime.
function jiraId(value, label) {
  const normalized = text(value, label);
  if (!/^[A-Za-z0-9:_-]+$/.test(normalized)) fail(`${label} is invalid.`);
  return normalized;
}

function jiraEnvName(value, label) {
  const normalized = text(value, label);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) fail(`${label} must be an environment variable name.`);
  return normalized;
}

function jiraBaseUrl(value) {
  let url;
  try { url = new URL(text(value, "jira.baseUrl")); } catch { fail("jira.baseUrl must be an HTTPS URL."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("jira.baseUrl must be an HTTPS origin URL.");
  }
  return url.toString().replace(/\/$/, "");
}

function jiraConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("jira must be an object.");
  const allowedKeys = [
    "baseUrl", "emailEnv", "apiTokenEnv", "projectId", "projectKey", "assigneeAccountId", "defaultPriorityId", "storyPointFieldId",
    "allowedIssueTypes", "epicJql", "maxEpicCandidates", "draftTtlMinutes", "maxCreateAttempts",
  ];
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== allowedKeys.length || actualKeys.some((key) => !allowedKeys.includes(key))) {
    fail("jira contains unsupported or missing fields.");
  }
  const issueTypes = value.allowedIssueTypes;
  if (!issueTypes || typeof issueTypes !== "object" || Array.isArray(issueTypes)
    || Object.keys(issueTypes).length !== 3 || ["Task", "Bug", "Story"].some((key) => !(key in issueTypes))) {
    fail("jira.allowedIssueTypes must contain exactly Task, Bug, and Story.");
  }
  const epicJql = text(value.epicJql, "jira.epicJql");
  if (!/^project\s*=\s*ED\s+AND\s+issuetype\s*=\s*Epic\s+AND\s+statusCategory\s*!=\s*Done$/i.test(epicJql)) {
    fail("jira.epicJql must be bounded to active ED Epics.");
  }
  const integer = (candidate, label, minimum, maximum) => {
    if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
    return candidate;
  };
  if (text(value.projectKey, "jira.projectKey") !== "ED") fail("jira.projectKey must be ED.");
  return Object.freeze({
    baseUrl: jiraBaseUrl(value.baseUrl),
    emailEnv: jiraEnvName(value.emailEnv, "jira.emailEnv"),
    apiTokenEnv: jiraEnvName(value.apiTokenEnv, "jira.apiTokenEnv"),
    projectId: jiraId(value.projectId, "jira.projectId"),
    projectKey: "ED",
    assigneeAccountId: jiraId(value.assigneeAccountId, "jira.assigneeAccountId"),
    defaultPriorityId: jiraId(value.defaultPriorityId, "jira.defaultPriorityId"),
    storyPointFieldId: jiraId(value.storyPointFieldId, "jira.storyPointFieldId"),
    allowedIssueTypes: Object.freeze({
      Task: jiraId(issueTypes.Task, "jira.allowedIssueTypes.Task"),
      Bug: jiraId(issueTypes.Bug, "jira.allowedIssueTypes.Bug"),
      Story: jiraId(issueTypes.Story, "jira.allowedIssueTypes.Story"),
    }),
    epicJql,
    maxEpicCandidates: integer(value.maxEpicCandidates, "jira.maxEpicCandidates", 1, 50),
    draftTtlMinutes: integer(value.draftTtlMinutes, "jira.draftTtlMinutes", 5, 10_080),
    maxCreateAttempts: integer(value.maxCreateAttempts, "jira.maxCreateAttempts", 1, 5),
  });
}

const normalizedJira = jiraConfig(config.jira);

// Phase 4: canonicalize repository allowlist entries and require the configured
// HTTPS remote to match each owner/repository slug exactly.
if (!repositories.length) fail("At least one repository is required.");
const seenSlugs = new Set();
const normalizedRepositories = [];
for (const [index, repository] of repositories.entries()) {
  const prefix = `repositories[${index}]`;
  const slug = text(repository.slug, `${prefix}.slug`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || slug.startsWith("example-org/")) {
    fail(`${prefix}.slug must be a real GitHub owner/repository slug.`);
  }
  if (seenSlugs.has(slug.toLowerCase())) fail(`Duplicate repository slug: ${slug}`);
  seenSlugs.add(slug.toLowerCase());
  const repositoryRoot = absolute(repository.root, `${prefix}.root`);
  const remoteUrl = text(repository.remoteUrl, `${prefix}.remoteUrl`);
  const expectedRemote = `https://github.com/${slug}.git`;
  if (remoteUrl !== expectedRemote) fail(`${prefix}.remoteUrl must equal ${expectedRemote}`);
  const baseBranch = text(repository.baseBranch, `${prefix}.baseBranch`);
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch)) fail(`${prefix}.baseBranch is invalid.`);
  await assertDirectory(repositoryRoot, `${prefix}.root`);
  normalizedRepositories.push({ slug, root: repositoryRoot, remoteUrl, baseBranch });
}

// Phase 5: resolve execution/storage boundaries. Every executable and PATH
// component must be absolute so child processes cannot depend on shell lookup.
const binaryNames = ["git", "gh", "ssh", "tflint", "trivy", "helm", "kustomize", "kubeconform"];
const normalizedBinaries = {};
for (const name of binaryNames) {
  normalizedBinaries[name] = absolute(binaries[name], `binaries.${name}`);
  await assertExecutable(normalizedBinaries[name], `binaries.${name}`);
}

const openclawStateDir = absolute(paths.openclawStateDir, "paths.openclawStateDir");
const workspace = absolute(paths.workspace, "paths.workspace");
const cacheDir = absolute(paths.cacheDir, "paths.cacheDir");
const processHome = absolute(paths.processHome, "paths.processHome");
const processPath = text(paths.processPath, "paths.processPath");
if (processPath.split(path.delimiter).some((entry) => !path.isAbsolute(entry))) {
  fail("Every paths.processPath entry must be absolute.");
}
await assertDirectory(processHome, "paths.processHome");
if (workspace === openclawStateDir || cacheDir === openclawStateDir) {
  fail("Workspace/cache paths must not replace the OpenClaw state directory.");
}

// Phase 6: container mode adds LAN binding only together with token auth; native
// mode leaves the host's gateway transport untouched.
let gatewayPatch = {};
if (container) {
  const gatewayTokenEnv = text(container.gatewayTokenEnv, "container.gatewayTokenEnv");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(gatewayTokenEnv)) {
    fail("container.gatewayTokenEnv must be an environment variable name.");
  }
  gatewayPatch = {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token", token: { source: "env", provider: "default", id: gatewayTokenEnv } },
    },
  };
}

const backendPluginIds = backendProfile === "codex" ? ["openai", "codex"] : ["anthropic"];
const backendPluginEntries = Object.fromEntries(backendPluginIds.map((id) => [id, { enabled: true }]));
const modelPolicy = backendProfile === "codex"
  ? { agentRuntime: { id: "codex" } }
  : { agentRuntime: { id: "claude-cli" } };
// Wildcard accounts receive Slack events from any channel where their App is
// invited. Static rules remain only for exact-channel accounts; Security Shield
// still authorizes the full account/workspace/channel/owner identity per turn.
const staticSlackChannels = Object.fromEntries(slackAccounts
  .filter((account) => account.channelId !== "*")
  .map((account) => [account.channelId, {
    requireMention: true,
    replyToMode: "all",
    users: [account.userId],
  }]));

// Phase 7: construct one declarative OpenClaw patch. Tools start from messaging
// profile, broad write/runtime groups are denied and only Friday operations are
// added back explicitly.
const patch = {
  ...gatewayPatch,
  agents: {
    defaults: {
      workspace,
      model: {
        primary: primaryModel,
        ...(fallbackModels.length ? { fallbacks: fallbackModels } : {}),
      },
      models: Object.fromEntries(configuredModels.map((model) => [model, modelPolicy])),
      ...(backendProfile === "claude-code"
        ? { cliBackends: { "claude-cli": { command: backendCommand } } }
        : {}),
    },
  },
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
      streaming: { mode: "partial", nativeTransport: true },
      thread: { requireExplicitMention: true },
      capabilities: { interactiveReplies: true },
      channels: staticSlackChannels,
      accounts: Object.fromEntries(slackAccounts.map((account) => [account.accountId, {
          enabled: true,
          name: account.accountName,
          botToken: { source: "env", provider: "default", id: account.botTokenEnv },
          appToken: { source: "env", provider: "default", id: account.appTokenEnv },
          groupPolicy: account.channelId === "*" ? "open" : "allowlist",
          dmPolicy: "disabled",
          allowFrom: [account.userId],
          replyToMode: "all",
        }])),
    },
  },
  plugins: {
    ...(container ? { load: { paths: ["/opt/friday/plugins/slack-project/node_modules/@openclaw/slack"] } } : {}),
    allow: [...backendPluginIds, "slack", "friday-git-adapter", "friday-jira-adapter", "friday-security-shield"],
    entries: {
      ...backendPluginEntries,
      slack: { enabled: true },
      "friday-git-adapter": {
        enabled: true,
        config: {
          repositories: normalizedRepositories,
          binaries: normalizedBinaries,
          storage: { cacheDir },
          process: { home: processHome, path: processPath },
        },
      },
      "friday-jira-adapter": {
        enabled: true,
        config: {
          jira: {
            baseUrl: normalizedJira.baseUrl,
            emailEnv: normalizedJira.emailEnv,
            apiTokenEnv: normalizedJira.apiTokenEnv,
            projectId: normalizedJira.projectId,
            projectKey: normalizedJira.projectKey,
            assigneeAccountId: normalizedJira.assigneeAccountId,
            defaultPriorityId: normalizedJira.defaultPriorityId,
            storyPointFieldId: normalizedJira.storyPointFieldId,
            allowedIssueTypes: normalizedJira.allowedIssueTypes,
            epicJql: normalizedJira.epicJql,
            maxEpicCandidates: normalizedJira.maxEpicCandidates,
          },
          slack: {
            accountId: slackAccounts[0].accountId,
            workspaceId: slackAccounts[0].workspaceId,
            botTokenEnv: slackAccounts[0].botTokenEnv,
          },
          workflow: {
            draftTtlMinutes: normalizedJira.draftTtlMinutes,
            maxCreateAttempts: normalizedJira.maxCreateAttempts,
          },
        },
      },
      "friday-security-shield": {
        enabled: true,
        hooks: { allowPromptInjection: true, allowConversationAccess: true },
        config: {
          principalEmail: ownerEmail,
          allowedSlackBindings: slackAccounts.map(({ accountId, workspaceId, channelId, userId }) => ({ accountId, workspaceId, channelId, userId })),
          silentDeny: true,
          auditRetentionDays: 30,
        },
      },
    },
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "write", "edit", "apply_patch", "sessions_spawn", "sessions_send", "gateway", "cron", "browser", "canvas"],
    elevated: { enabled: false },
    // Slack-facing review requests are routed through the unified gate only.
    // Lower-level context/engine tools remain part of the plugin for future
    // trusted integrations, but are intentionally not model-callable here:
    // otherwise an agent could bypass the canonical verdict and reinterpret
    // baseline findings as merge blockers.
    alsoAllow: ["friday_unified_pr_review", "friday_batch_pr_review", "friday_jira_get_context", "friday_jira_prepare_ticket"],
  },
};

// --check proves the configuration contract without creating build/cache paths.
if (checkOnly) {
  process.stdout.write(`Instance configuration is valid: ${configPath}\n`);
  process.exit(0);
}

// Phase 8: render into a staging directory. Active OpenClaw state is mutated by
// a later setup/apply step, never by this generator.
const workspaceBuildDir = path.join(buildDir, "workspace");
await mkdir(workspaceBuildDir, { recursive: true, mode: 0o700 });
await mkdir(cacheDir, { recursive: true, mode: 0o700 });
await writeFile(path.join(buildDir, "openclaw.patch.json"), `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 });

const templateDir = path.join(root, "templates", "workspace");
const replacements = new Map([
  ["{{ASSISTANT_NAME}}", assistantName],
  ["{{OWNER_EMAIL}}", ownerEmail],
  ["{{LANGUAGE}}", language],
  ["{{TIMEZONE}}", timezone],
  ["{{MODEL_BACKEND}}", backendProfile],
  ["{{PRIMARY_MODEL}}", primaryModel],
  ["{{REPOSITORY_LIST}}", normalizedRepositories.map(({ slug, baseBranch }) => `- \`${slug}\` (base: \`${baseBranch}\`)`).join("\n")],
]);
for (const file of await readdir(templateDir)) {
  let content = await readFile(path.join(templateDir, file), "utf8");
  for (const [needle, value] of replacements) content = content.replaceAll(needle, value);
  await writeFile(path.join(workspaceBuildDir, file), content, { mode: 0o600 });
}

process.stdout.write([
  `Prepared ${path.join(buildDir, "openclaw.patch.json")}`,
  `Prepared ${workspaceBuildDir}`,
  "No token value was read or written.",
].join("\n") + "\n");
