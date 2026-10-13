# Phase 0B Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Read `AGENTS.md`,
> `docs/SYSTEM_DESIGN.md`, `docs/ROADMAP.md` and this plan, in that order, and
> use the phase-work skill.

**Status:** Target. Awaiting human approval. No implementation may start
before the owner approves this plan in its PR.

**Goal:** Close known baseline defects in review accuracy, redaction,
untrusted-content wrapping and Security Shield scope, make the container
deployment movable to another host without host-specific binds, and produce
declaration-level evidence for an
OpenClaw upgrade, all without widening Friday's runtime authority.

**Architecture:** Four independent slices. Each slice is one worktree and one
PR, and none depends on another slice's code. Slice A and Slice B harden
existing boundaries. Slice C removes host coupling from the container path while
keeping the native macOS path working. Slice D is a read-only spike that only
writes a report.

**Tech Stack:** Node.js `>=24`, npm `>=11`, TypeScript/ESM, `node:test`,
OpenClaw `2026.7.1-2` (pinned; unchanged by this phase), Docker Compose v2.

**Context:** Direction agreed with the owner on 2026-10-13 ("Đợt 0 · Nền
móng"): run locally but stay deployable anywhere; keep OpenClaw for Friday;
keep all existing read-only and approval boundaries.

## State vocabulary

Use the Phase 0 labels: **Current**, **Validated**, **Target**,
**Runtime-proven**. A build or unit test is never runtime proof.

## Baseline evidence (commit `9fcec5e`, after PR #5, PR #6 and PR #7)

- PR #6 resolved ROADMAP review items 1-4 and PR #7 recorded them as
  Resolved. Review item 5 remains open: `wrapUntrustedContent` in
  `core/shared/src/untrusted.ts` only truncates and does not neutralize
  `BEGIN UNTRUSTED DATA` / `END UNTRUSTED DATA` markers inside the content.
  It is live on `main` for the OpenAI docs tool, so a fetched document can
  close the untrusted block early. Slice A fixes it (task A3).
- PR #7 moved the GitNexus skills to `.claude/skills/gitnexus-*/` and renamed
  the index to `assistant-devops-ai-bot`; use the commands in the current
  `AGENTS.md` GitNexus block.
- `integrations/git-adapter/gitops-review.ts` hard-codes Kubernetes `1.30.0`
  in five places: two `helm lint`, two `helm template` and one `kubeconform`
  invocation. Every repository is validated against the same version.
- Redaction is implemented three times with different coverage:
  `integrations/git-adapter/core.ts` `redact()` has no JWT pattern;
  `core/security-shield/core.ts` `sanitizeFridayOutput()` covers only `ghp_`
  and `github_pat_` for GitHub tokens and no JWT; the OpenAI docs adapter has
  the widest set. Egress redaction is narrower than evidence redaction.
- PR #5 added four build-time patches to installed OpenClaw files
  (`scripts/openclaw-trace-fix.mjs`, `openclaw-ingress-trace-fix.mjs`,
  `openclaw-runner-usage-trace-fix.mjs`, `openclaw-diagnostics-usage-fix.mjs`),
  applied in the `Dockerfile` and pinned by file name, hash or anchor. Together
  with `compat/slack` there are now six vendor patch flows tied to
  OpenClaw `2026.7.1`.
- `before_tool_call` in `core/security-shield/index.ts` returns without
  blocking when the session key does not contain `:slack:`. A Friday tool
  reached through another gateway transport is not authorized by the Shield.
- `PerTurnAuthorizationRegistry` grants are revoked only in `agent_end`; a run
  that never emits `agent_end` leaves its grant until gateway stop. The same
  applies to `verifiedReviewGates`.
- `compose.yaml` requires `FRIDAY_REPOSITORIES_DIR` and binds it to
  `/repos:ro`; every `repositories[].root` must point inside that host bind.
- `compose.yaml` defines a gateway healthcheck and `restart: unless-stopped`.
  Docker does not restart a container that is merely unhealthy, so the
  container path has no recovery equivalent to the macOS launchd watchdog.
- The image is built locally as `friday:${FRIDAY_IMAGE_TAG}`; there is no CI
  workflow and no registry image.
- `compat/slack/manifest.json` pins patches to `@openclaw/slack` `2026.7.1`
  by file name and SHA-256. Any OpenClaw upgrade invalidates them.
- Validated at `7ceb603` (code unchanged by PR #7) in a Linux sandbox with Node 22 (below the `>=24`
  engine) and no Docker daemon: both audits pass for 6 workspaces, every
  workspace check passes, and root `npm test` fails only three
  Docker-dependent tests (collector privacy, trace probe target bytes, pinned
  selection preimage). Docker-dependent tests must run on the Mac.

## Global constraints

- No new model-facing tool, generic shell, filesystem write, GitHub write,
  deployment, cluster mutation or arbitrary network operation.
- Security Shield remains the sole authorization authority. Every change to it
  must be fail-closed: on missing or ambiguous identity, deny.
- No secret, token-shaped literal, local path or runtime state in source,
  fixtures or docs. Build token-shaped test inputs by concatenation at runtime
  so `audit:portability` stays green.
- Do not edit installed OpenClaw files, apply compatibility patches, log in,
  or start/mutate a runtime to validate source changes.
- Before editing any existing function, run GitNexus upstream impact analysis
  on the current worktree index. On `HIGH` or `CRITICAL`, report the blast
  radius and stop for owner review. Run `detect_changes` before each commit.
- Defaults must preserve current behavior for an unchanged configuration.
- Git identity for commits and pushes: `0xKMT`. Branch prefix `0xKMT/`.
- Do not commit or push without the owner's request.

## Out of scope

- Phase 1 operator gates (merge, Docker tests on the Mac, live Slack proof);
  these are human tasks tracked in ROADMAP.
- The OpenClaw version bump itself (needs its own plan after Slice D).
- Agentic review, rubrics, content/research adapters, memory, and every
  Phase 2+ or P6 item.
- Google Workspace, AWS, Datadog and Kubernetes credentials (deferred by the
  owner).

## Slice A: Review hygiene

Worktree/branch: `0xKMT/phase-0b-a-review-hygiene`.

### Files

- Modify: `integrations/git-adapter/runtime-config.ts`
- Modify: `integrations/git-adapter/gitops-review.ts`
- Create: `core/shared/src/redaction.ts`; modify `core/shared/src/index.ts`
- Modify: `core/shared/src/untrusted.ts`, `docs/ROADMAP.md` (item 5 status)
- Modify: `integrations/git-adapter/core.ts`
- Modify: `core/security-shield/core.ts`
- Modify: `integrations/openai-docs-adapter/local-error-log.ts`
- Modify: `config/instance.example.json`, `config/instance.container.example.json`
- Modify: `config/README.md`, `integrations/git-adapter/README.md`
- Test: `integrations/git-adapter/test/runtime-config.test.ts`,
  `integrations/git-adapter/test/gitops-review.test.ts`,
  `integrations/git-adapter/test/core.test.ts`,
  `core/security-shield/test/core.test.ts`, `core/shared/src/redaction.test.ts`,
  `integrations/openai-docs-adapter/test/local-error-log.test.ts`,
  `core/shared/src/untrusted.test.ts`

### Tasks

- [ ] **A1 · Per-repository Kubernetes version.** Add optional
  `repositories[].kubernetesVersion` to `RepositoryConfig`. Validate
  `^1\.\d{1,2}\.\d{1,3}$`; reject anything else at parse time. Default
  `1.30.0` when absent. Replace the five literals in `gitops-review.ts` with
  the reviewed repository's value. Tests: default preserved, valid override
  reaches all three tools, invalid value fails config parsing.
- [ ] **A2 · One credential-pattern set.** Move the credential-shaped
  patterns into a single bounded helper in `@friday/shared` (the same move
  PR #6 made for `wrapUntrustedContent`), starting from the union of the three
  current sets: private keys, `AKIA`/`ASIA`, `gh[oprsu]_`, `github_pat_`,
  `xox[abprs]-`, `xapp-`, Slack webhooks, JWT, `sk-`, URL userinfo. Each caller
  keeps its own context rules (the git-adapter name/value and HCL rules, the
  Shield's internal-name replacements, the error log's header rules) and adds
  the shared set. Tests use runtime-assembled synthetic values and assert every
  family is removed by all three callers. Redaction may only get wider.

- [ ] **A3 · Untrusted-block integrity (ROADMAP item 5).** Make
  `wrapUntrustedContent` neutralize any line in the content that could be read
  as a `BEGIN UNTRUSTED DATA` or `END UNTRUSTED DATA` marker (case-insensitive,
  with or without the label, with leading whitespace or Unicode look-alike
  spacing), for example by prefixing it so it no longer matches the marker
  form. Truncation still applies after neutralization. Callers keep the same
  signature. Tests: content containing an exact END marker, a lowercase one, a
  label-less one and a BEGIN marker cannot end or restart the block; normal
  content is byte-identical. Run impact analysis on `wrapUntrustedContent`
  first: every docs and Shield caller is affected. Mark item 5 Resolved in
  `docs/ROADMAP.md` in the same PR.

### Acceptance

- Unchanged configuration produces the same review commands as before.
- `npm test`, `npm run typecheck`, `npm run build`, `git diff --check` pass
  (Docker-dependent tests reported as skipped when no daemon is present).

## Slice B: Security Shield scope and grant lifetime

Worktree/branch: `0xKMT/phase-0b-b-shield-hardening`. Expect GitNexus to rate
these symbols high-risk; report impact and wait for review before editing.

### Files

- Modify: `core/security-shield/index.ts`
- Modify: `core/security-shield/core.ts`
- Modify: `core/security-shield/README.md`, `docs/security-persona-shield-v1.md`
- Test: `core/security-shield/test/core.test.ts` (and a new hook-level test if
  the existing harness allows it without a runtime)

### Tasks

- [ ] **B1 · Fail closed outside Slack.** In `before_tool_call`, block any
  tool whose name starts with `friday_` unless the run holds a Slack grant,
  whatever the transport. Non-Friday tools keep current behavior. Record a
  deny audit entry with reason `tool-call:non-slack-transport`.
- [ ] **B2 · Bounded grant lifetime.** Give each `AuthorizedTurn` an
  `expiresAt` (default 15 minutes, configurable within 1 to 60 minutes via
  plugin config). `has()` treats expired grants as absent and prunes them.
  Apply the same expiry to `verifiedReviewGates`. `agent_end` revocation stays.
- [ ] **B3 · Tests.** Expired grant denies; non-Slack `friday_*` call denies;
  authorized Slack run still allows; configuration outside bounds fails parse.

### Acceptance

- No authorized Slack flow changes behavior.
- Every new path denies on missing data.
- Full gate passes.

## Slice C: Container portability

Worktree/branch: `0xKMT/phase-0b-c-portability`. The native macOS path
(`setup:full`, launchd watchdog) must keep working unchanged.

### Files

- Create: `.github/workflows/image.yml`
- Modify: `compose.yaml`, `container/.env.example`, `container/entrypoint.sh`
- Modify: `integrations/git-adapter/runtime-config.ts`, `integrations/git-adapter/core.ts`
- Modify: `scripts/container-bootstrap.mjs`, `scripts/prepare-instance.mjs`
- Modify: `docs/CONTAINER_SETUP.md`, `docs/RUNTIME_AND_DATA_OWNERSHIP.md`, `README.md`
- Test: `integrations/git-adapter/test/runtime-config.test.ts`,
  `scripts/test/container-observability.test.mjs` and new script tests as needed

### Tasks

- [ ] **C1 · Registry image.** Add a GitHub Actions workflow that builds the
  existing `Dockerfile` for `linux/arm64` and `linux/amd64` and pushes to
  `ghcr.io/0xkmt/friday` on tags and manual dispatch, with a private package.
  Pin every action to a commit SHA. The workflow uses only `GITHUB_TOKEN` with
  `packages: write`; no other secret. Compose reads the image from
  `FRIDAY_IMAGE` and keeps the current local tag as the default.
- [ ] **C2 · Repository mirrors in the state volume.** Add an optional
  repository source mode in which Friday keeps a bare mirror under its state
  directory instead of a host bind. Fetches use the existing HTTPS GitHub
  remote and the `gh` credential already in the volume. Existing
  `repositories[].root` binds keep working; `FRIDAY_REPOSITORIES_DIR` becomes
  optional when every repository uses mirror mode. Keep fetch bounded by the
  existing timeouts and the `refs/friday` namespace; never check out a working
  tree.
- [ ] **C3 · Container self-recovery.** Make the container path recover from a
  persistently unhealthy gateway without launchd: the entrypoint supervises the
  gateway and exits non-zero after N consecutive failed health probes so
  `restart: unless-stopped` restarts it. Document that the launchd watchdog is
  for the native macOS path only.
- [ ] **C4 · Move runbook.** Document "rebuild on a clean Linux host" in
  `docs/CONTAINER_SETUP.md`: pull image, restore secrets and backup, log in
  where required, health check. No secrets or personal paths in the doc.

### Acceptance

- `docker compose config` resolves with and without `FRIDAY_REPOSITORIES_DIR`
  according to the configured mode.
- Owner rebuilds Friday on a clean Linux host from the runbook (human gate;
  runtime-proven only after the owner records it).

## Slice D: OpenClaw upgrade compatibility spike

Worktree/branch: `0xKMT/phase-0b-d-openclaw-spike`. Report only; no source
behavior change.

### Files

- Create: `docs/OPENCLAW_UPGRADE_SPIKE.md`

### Tasks

- [ ] **D1** Install the latest stable OpenClaw and `@openclaw/slack` into a
  throwaway directory outside the repository. Do not log in or start a gateway.
- [ ] **D2** From installed declarations, record the presence and shape of
  every hook Friday uses: `before_dispatch`, `before_agent_run`,
  `reply_dispatch`, `before_tool_call`, `after_tool_call`, `agent_end`,
  `before_prompt_build`, `message_sending`, `gateway_stop`, and the
  `definePluginEntry` / `registerTool` contracts.
- [ ] **D3** For each of the six vendor patch flows (two in `compat/slack`,
  four `scripts/openclaw-*-fix.mjs` applied in the `Dockerfile`), determine
  whether the new version provides the behavior natively, whether the target
  file and anchor still exist, and whether the patch is still needed.
- [ ] **D4** List breaking changes that affect Friday (for example the
  `codex/*` → `openai/*` model reference migration and credential, egress and
  plugin-consent features introduced in 2.0) and recommend: bump with patches
  removed, bump with re-derived patches, or hold.

### Acceptance

- The report labels every finding Validated (declaration-level) or Unknown.
  It never claims runtime behavior.

## Rollback

Each slice is one PR; revert the PR. Slice A and Slice C defaults preserve
existing configuration behavior. Slice B can be reverted without data
migration; grant state is in memory only.

## Suggested order

A → B → D → C. Slice C is the largest and benefits from Slice D's findings
about container and plugin changes.
