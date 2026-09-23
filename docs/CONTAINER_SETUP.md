# Friday Container Edition

Container Edition runs the OpenClaw gateway, Codex/Claude Code CLI, Friday
plugins, and validators in a non-root image. The host needs Docker Engine or
Desktop, Compose v2, a browser for first login, and local repositories to review.

## Pinned Components

- OpenClaw image `2026.7.1-2` pinned by OCI digest for amd64 and arm64
- Codex CLI `0.147.0` and Claude Code `2.1.226`
- bundled Slack plugin `2026.7.1` and reproducible guarded compatibility patches
- TFLint `0.64.0`, Trivy `0.70.0`, Helm `4.1.3`, Kustomize `5.8.1`,
  kubeconform `0.8.0`, and GitHub CLI `2.97.0`
- architecture-specific SHA-256 checksums for downloaded binaries

## 1. Initialize Local Files

```bash
npm run container:init
```

This creates ignored local files without overwriting existing values:

- `container/.env`
- `config/instance.container.json`
- `container/secrets/gateway-token` with a random token
- empty account-specific Slack secret files
- `container/secrets/jira-api-token` for the configured Jira token
- `container/backups/`

It never prints secret values.

## 2. Configure Repositories and Instance

Place every reviewed repository below one host parent directory, for example:

```text
/srv/friday-repositories/
  platform-infrastructure/
  application-gitops/
```

Set that parent in `FRIDAY_REPOSITORIES_DIR` inside `container/.env`. Compose
mounts it at `/repos:ro`, so each `repositories[].root` must be
`/repos/<folder>`.

Replace every placeholder in `config/instance.container.json`. For Claude Code:

```json
{
  "modelBackend": {
    "profile": "claude-code",
    "primaryModel": "anthropic/claude-opus-4-8",
    "command": "/usr/local/bin/claude"
  }
}
```

Do not change `container.imageVersion` unless you also update and test the
corresponding image pin.

The required `jira` block is a single Everfit Devops destination: `projectKey`
must be `ED`, with stable project, assignee (Tri Pham), Medium-priority, and
Task/Bug/Story type IDs. Set `apiTokenEnv` to the environment-variable name that
the container will load and `emailEnv` to the Jira account-email variable name.
Put that email value in `container/.env`; the API-token value goes only in
`container/secrets/jira-api-token`. `storyPointFieldId` is the numeric Story
point custom field shown in the private edit form. The adapter allows only the
bounded active-ED Epic JQL in the example. It never creates Epics and uses `No
Epic` unless it has a high-confidence existing match.

## 3. Add Slack Accounts and Secrets

`slack.accounts[]` is required. Each record represents one independently
authorized Slack App and must contain exact `accountId`, `workspaceId`,
`userId`, `botTokenEnv`, and `appTokenEnv` values. `channelId` may be an exact
`C...`/`G...` ID or `"*"`. The wildcard permits the configured owner to invoke
that App from any channel where it is invited; it does not permit other users or
other workspaces. Account IDs are unique and each workspace has one account
record.

Create a separate Slack App in each workspace. Then write exactly one value,
without labels or quotes, into the gateway token file and each account's pair of
secret files. For `accountId: "infra-review"`:

- `container/secrets/gateway-token`
- `container/secrets/slack-infra-review-bot-token`
- `container/secrets/slack-infra-review-app-token`

Also place the Jira API-token value, with no labels or quotes, in:

- `container/secrets/jira-api-token`

For `accountId: "everfit"`, add `slack-everfit-bot-token` and
`slack-everfit-app-token`. `npm run container:init` creates empty placeholders
for all configured accounts without overwriting non-empty values.

Docker mounts generated account secrets at `/run/secrets`; the entrypoint
exports them only to the Friday process under the configured environment names.
They are not in the image, JSON configuration, source archive, or Git.

### Migrate an Existing Single-Workspace Container

1. Replace the old singular `slack` object in
   `config/instance.container.json` with the required `slack.accounts` array.
2. Choose a stable `accountId`, then put the existing bot/app token values in
   `container/secrets/slack-<accountId>-bot-token` and
   `container/secrets/slack-<accountId>-app-token`.
3. Add a second account record and its two token files only after a second Slack
   App is installed in its workspace.
4. Run the dry-run command below. Apply only after every account pair is present.

The migration changes only the Friday Compose project and its named volume. It
does not stop, reconfigure, or share credentials with a native OpenClaw gateway.

## 4. Build and Dry-Run

```bash
npm run container:setup -- --backend codex
# or
npm run container:setup -- --backend claude-code
```

This builds the image and validates configuration, repositories, binaries, and
the OpenClaw patch. It does not log in, install into persistent state, apply
configuration, or start the gateway.

## 5. Authenticate and Apply

```bash
npm run container:setup -- --backend codex --login --apply
# or
npm run container:setup -- --backend claude-code --login --apply
```

The flow authenticates GitHub first and then the selected model backend. For
headless Codex OAuth, open the printed URL in a local browser and paste the full
redirect URL into the terminal when prompted. Credentials persist only in the
`friday_home` volume.

Apply requires the gateway token, every configured account token pair, and
`container/secrets/jira-api-token`; it backs up prior state, runs preflight, applies
the generated patch, installs bundled plugins, validates configuration, starts
the gateway, and runs health checks. The default published address is
`127.0.0.1:18789`.

## 6. Health and Acceptance

```bash
npm run container:health
```

The health script checks container state, `/healthz`, `/readyz`, configuration,
model authentication, and Slack deep status. Then run the complete
[Acceptance Checklist](ACCEPTANCE.md), including the non-owner silent-deny test.

## Optional Phase 1 Observability (Container Only)

**Current:** plain `compose.yaml` runs Friday without diagnostics, Collector, or
Phoenix. **Validated:** the opt-in overlay passes Compose and Collector config
checks, the pinned image builds with `diagnostics-otel`, the synthetic
post-Collector privacy probe passes, and `npm run eval:golden` reproduces four
synthetic results. **Target:** an authorized Slack request, read-only tool, and
response appear in one Phoenix trace without protected content.
**Runtime-proven:** not yet; only a controlled configured Friday turn can
establish that state. The golden fixtures do not evaluate a live model.

Complete the ordinary `container:setup --apply` and acceptance procedure above
separately before opting in. The observability overlay does not initialize
credentials, install into persistent Friday state, or authorize a requester.
From the repository root, validate and start the overlay:

```bash
docker compose --env-file container/.env \
  -f compose.yaml -f build/container-secrets.compose.yaml \
  -f compose.observability.yaml --profile observability config --quiet
docker compose --env-file container/.env \
  -f compose.yaml -f build/container-secrets.compose.yaml \
  -f compose.observability.yaml --profile observability up -d --build
```

Phoenix UI is at `http://127.0.0.1:6006`. The Collector has no published host
port. Phoenix data uses the separate `friday_phoenix_data` named volume; it is
not a Friday audit, Jira workflow, cache, or authorization database. The
gateway reads a private alternate config on its tmpfs only while the overlay
is active. Its persisted `openclaw.json` remains the plain configuration.

For a controlled runtime check, ask the configured owner to send one synthetic,
authorized, read-only Slack request. In Phoenix, confirm
`openclaw.message.processed`, `openclaw.run`, `openclaw.tool.execution`, and
`openclaw.message.delivery` share one trace ID. Inspect only in the private UI:
no prompt, Slack text, secret, local path, raw identifier, tool argument or
output, event, link, status message, or synthetic sentinel may appear. A
missing span or uninspected payload means **Not runtime-proven**; do not enable
content capture to force a trace. Security Shield and Jira approval remain
authoritative regardless of telemetry health. Record only the evidence state
and pass/fail in shared notes, never a raw trace or runtime payload.

Run the independent, offline golden baseline with `npm run eval:golden`. Its
versioned source is `eval/golden/container-v1.jsonl`; it makes no Slack, Jira,
model, or infrastructure call. A passing result proves the deterministic
fixture/evaluator contract, not live request quality.

To stop observability without deleting either named volume, then return to the
plain gateway:

```bash
docker compose --env-file container/.env \
  -f compose.yaml -f build/container-secrets.compose.yaml \
  -f compose.observability.yaml --profile observability down
sh container/compose.sh up -d friday-gateway
```

The `down` command stops the Friday gateway too; the second command restarts
the ordinary uninstrumented service. Do not add `-v` to `down`: volume deletion
is a separate owner decision. To roll back the Phase 1 implementation, revert
its commits, rebuild the image, and restart the plain service while retaining
`friday_home` and `friday_phoenix_data` for recovery/review.

## 7. Backup and Rollback

```bash
npm run container:backup
ls -l container/backups
npm run container:rollback -- friday-home-YYYYMMDDTHHMMSSZ.tgz
npm run container:rollback -- friday-home-YYYYMMDDTHHMMSSZ.tgz --apply
```

Backups contain persistent OAuth/GitHub credentials and state. Keep them local,
use `0600` permissions, encrypt external storage, and never include them with
source. Rollback does not replace Docker secret files.

The Jira draft database is stored in the persistent Friday/OpenClaw home volume
as `friday-jira.sqlite`. Rollback restores the selected volume snapshot, so it
can restore a pre-create draft state; it does not delete the current database
or Docker secret files. To preserve recovery evidence after a partial create,
back up first and keep the database. Deleting `friday-jira.sqlite` (and any WAL
sidecars) is a separate destructive operator action, not part of rollback.

## Security and Operations

- The container runs as `node`, uses a read-only root filesystem,
  `no-new-privileges`, no Linux capabilities, and a `noexec` tmpfs `/tmp`.
- Repositories are read-only; state, workspace, and cache use named volumes.
- Do not mount the Docker socket.
- Do not expose the port to a LAN or the Internet without an authenticated,
  hardened reverse proxy.
- Do not use `latest`. Upgrade by changing the version/digest, building,
  dry-running, backing up, applying, and repeating acceptance tests.
- Trivy `0.70.0` is used instead of the release affected by the March 2026
  [supply-chain incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).

Upstream references: [OpenClaw Docker](https://docs.openclaw.ai/install/docker),
[OpenAI authentication](https://learn.chatgpt.com/docs/auth.md), and
[Claude Code setup](https://code.claude.com/docs/en/getting-started).
