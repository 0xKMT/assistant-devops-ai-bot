# Full Native-Host Setup

Do not copy another machine's `~/.openclaw`, OAuth profiles, databases, logs, or
caches. Every operator creates their own identity and secrets.

## 1. Install Prerequisites

Use macOS or Linux with Node.js 24, npm, OpenClaw `2026.7.1-2`, Git, GitHub CLI,
TFLint, Trivy, Helm, Kustomize, and kubeconform. Install the pinned OpenClaw
version:

```bash
npm install --global openclaw@2026.7.1-2
node --version
openclaw --version
git --version
gh --version
```

Authenticate GitHub with an account that can read the reviewed repositories:

```bash
gh auth login
gh auth status
```

Clone each reviewed repository locally and ensure its `origin` matches the
configured HTTPS allowlist URL exactly.

## 2. Select One Model Backend

In `config/instance.json`, use either:

- `codex` with an `openai/*` model and OpenClaw OpenAI login; or
- `claude-code` with an `anthropic/*` model and an absolute Claude executable.

See [Model Backends](MODEL_BACKENDS.md).

## 3. Create the Slack App

For each workspace, import `config/slack-app-manifest.json`, enable Socket Mode,
create an app-level token, install the app, and obtain its bot token. Follow
[Slack App Setup](SLACK_APP.md). Never place token values in JSON or Git, and do
not reuse a bot or app token across workspaces.

## 4. Configure Jira for Everfit Devops

Phase 1 is bound to Everfit Devops, project key `ED`; it is not a general Jira
connection. Create a Jira API token for the configured Jira email with the
minimum access needed to browse active ED Epics and create ED Task, Bug, and
Story issues assigned to Tri Pham. Store only its environment-variable name in
configuration, never its value.

Use stable identifiers from Jira administration or the Jira REST API v3 for:

- `jira.projectId` for Everfit Devops and fixed `jira.projectKey: "ED"`;
- `jira.assigneeAccountId` for Tri Pham;
- `jira.defaultPriorityId` for Medium; and
- `jira.storyPointFieldId` for the numeric Story point estimate custom field; and
- the exact `jira.allowedIssueTypes` IDs for Task, Bug, and Story.

To inspect the configured IDs without placing a token in a command, use Jira's
project and user administration screens. If an operator uses REST discovery,
keep the token in an existing environment variable, omit verbose HTTP logging,
and inspect only the response fields; never paste a token into a URL, a config
file, or a ticket. The adapter accepts an HTTPS Jira origin, a bounded active-ED
Epic JQL, 1--50 Epic candidates, a 5--10,080 minute draft TTL, and 1--5 create
attempts.

## 5. Configure the Instance

```bash
npm ci
cp config/instance.example.json config/instance.json
```

Replace every placeholder: owner email, backend, Slack IDs, repositories,
binaries, OpenClaw state directory, workspace, cache, home, and PATH. Use
`command -v <binary>` for absolute binary paths.

Configure one exact Slack App binding per `slack.accounts[]` record. Each
`botTokenEnv` and `appTokenEnv` field is a variable name, not a value. Export a
matching secret pair for every account only in the setup terminal:

```bash
export FRIDAY_PRIMARY_SLACK_BOT_TOKEN='bot-token-value'
export FRIDAY_PRIMARY_SLACK_APP_TOKEN='app-token-value'
export FRIDAY_JIRA_EMAIL='jira-account-email'
export FRIDAY_JIRA_API_TOKEN='jira-api-token-value'
```

For a second account, use a distinct account ID, workspace/channel/owner tuple,
environment-variable names, and token pair. `--write-env` persists only the
configured names with `0600` permissions.

`FRIDAY_JIRA_EMAIL` and `FRIDAY_JIRA_API_TOKEN` must match `jira.emailEnv` and
`jira.apiTokenEnv`; both names are configurable, but these are the repository
examples. `--write-env` persists the configured Slack and Jira secret names only
with `0600` permissions. Do not put an email value or token value in
`config/instance.json`.

## 6. Preflight and Dry-Run

```bash
npm run setup:preflight -- --config config/instance.json
npm run setup:full -- --config config/instance.json
```

Dry-run runs tests and generates `build/openclaw.patch.json` and
`build/workspace/`; it does not change OpenClaw, install plugins, persist
secrets, or restart services. Review the patch, especially allowed plugins,
model, Slack account, and repositories.

## 7. Authenticate and Apply

```bash
npm run setup:full -- --config config/instance.json --login --apply --write-env --start
```

The setup validates the machine and instance, logs into the selected backend,
runs tests, backs up configuration/workspace, installs and verifies the pinned
Slack plugin and compatibility patches, writes state `.env` with mode `0600`,
installs Friday plugins (including `@friday/jira-adapter`), applies the patch,
validates health, and starts the gateway. It requires the configured Jira API
token as well as Slack tokens when `--write-env` is used.

If another service manager owns the gateway, omit `--start` and restart it
explicitly. If secrets are already in the state `.env`, omit `--write-env`.

## 8. Acceptance and Upgrade

Run [Acceptance](ACCEPTANCE.md). If a check fails, use
[Troubleshooting](TROUBLESHOOTING.md); use [Rollback](ROLLBACK.md) when needed.
For upgrades, keep pins explicit: back up, test, validate, restart, and repeat
the complete acceptance matrix.

Upstream references: [OpenClaw installation](https://docs.openclaw.ai/install),
[OpenAI authentication](https://learn.chatgpt.com/docs/auth.md), and
[Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started).

### Jira operator check

After apply, run `openclaw plugins doctor` and use the Jira cases in
[Acceptance](ACCEPTANCE.md). A request creates a private, editable draft first:
title, Task/Bug/Story type, English description, Medium-or-edited priority,
numeric Story point estimate, and existing Epic or `No Epic`. There is no Jira
write before the requester uses the Approve & Create action. If an approved
issue is created but the Slack URL post fails, retry only the link delivery from
the requester review; do not start a new draft or manually repeat Jira creation.
