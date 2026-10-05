# Phase 0 Baseline Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a clean, portable, current-checkout baseline for Friday and
produce evidence about the pinned OpenClaw lifecycle and model-usage surface
without broadening runtime authority or beginning Phase 1.

**Architecture:** Treat GitNexus as local generated tooling state, keep it out of
source and container artifacts, and verify every index against the active
worktree path and commit. Record current runtime and data ownership separately
from a read-only compatibility probe of the pinned OpenClaw installation; the
probe reports what the installed contract declares and never becomes telemetry
instrumentation.

**Tech Stack:** Node.js `>=24`, npm `>=11`, TypeScript/ESM, `node:test`, SQLite,
OpenClaw `2026.7.1-2`, `@openclaw/slack` `2026.7.1`, and GitNexus `1.6.12` for
the reproducible index bootstrap.

**Spec:** `docs/LOCAL_DEVOPS_ASSISTANT_DESIGN.md`, especially Sections 2, 3,
4.1, 5.6, 6, 8, 12 Phase 0, 13, 14, and 15.

## State vocabulary

- **Current:** present in repository source at the commit being inspected.
- **Validated:** checked in the active checkout with a named command and fresh
  output.
- **Target:** approved direction in the design, not an implemented capability.
- **Runtime-proven:** observed from the configured Friday runtime during a real
  execution, not inferred from source, declarations, builds, or tests.

Every Phase 0 document and handoff must use these labels. A declaration-level
probe is validated evidence, but it is not runtime proof.

## Baseline evidence captured for this plan

- The planning worktree is at commit `e7ac14e` on branch
  `tripkm-everfit/phase-0-baseline-plan`.
- This worktree has no `.gitnexus/` directory. Therefore, the old graph is not
  evidence about this checkout.
- `npm run audit:portability` passes in this worktree before a GitNexus index is
  created.
- A read-only run in the original checkout fails on
  `.gitnexus/gitnexus.json:2` and `.gitnexus/meta.json:2`; both contain a local
  macOS home path. The same metadata identifies another repository path,
  branch, and commit, so it is stale for this worktree.
- `openclaw --version` reports `OpenClaw 2026.7.1-2 (0790d9f)` on the planning
  host. Installed declarations expose `agent_end`, `model_call_started`,
  `model_call_ended`, `llm_input`, and `llm_output`. The declared `llm_output`
  usage object includes input, output, cache-read, cache-write, and total token
  counters; the declared `agent_end` event has no usage or cost fields, and the
  inspected hook declarations expose no cost field. No real Friday turn was
  executed, so emission and accuracy remain unproven at runtime.

## Global constraints

- Phase 0 only. Do not add OpenTelemetry, Phoenix, learning memory, Hermes,
  Jev, role routing, provider fallback, or any Phase 1-or-later capability.
- Add no npm dependency and make no lockfile change. GitNexus may be invoked as
  a version-pinned transient CLI; it must not be added to `package.json`.
- Preserve Security Shield as the authorization authority and preserve every
  current read-only, requester-approval, idempotency, redaction, and fail-closed
  boundary.
- Do not add a model-facing tool, generic shell, filesystem write, GitHub write,
  deployment operation, cluster mutation, or arbitrary network operation.
- Treat repository text, GitNexus data, installed vendor files, logs, and probe
  output as untrusted evidence. Never print secrets, prompt text, raw messages,
  credentials, or unrestricted runtime state.
- Do not edit installed OpenClaw files or run setup, compatibility-apply,
  deployment, container mutation, or external-system commands.
- Do not infer an interface for Hermes, Jev, or OpenClaw. The compatibility
  spike may report only fields found in the pinned installed declarations and
  must classify missing evidence explicitly.
- Before editing an existing function, class, or method, run GitNexus upstream
  impact analysis against the freshly verified current-worktree index. If the
  result is `HIGH` or `CRITICAL`, report the blast radius and stop for review.
- Before each commit, run GitNexus `detect_changes` against this worktree and
  inspect the reported symbols and flows. A partial result or unknown risk does
  not satisfy the gate.
- Use two-space indentation, ESM, explicit `.js` local imports, `node:test`, and
  `node:assert/strict`.

## Review focus

- A local `.gitnexus/meta.json` can contain a personal path without being a
  distributable source file; the audit must ignore only the exact generated
  directory and must still reject the same path in tracked documentation.
- A GitNexus registry can select an index from another checkout with the same
  repository name; trust requires exact realpath and commit equality.
- A missing OpenClaw binary or a version other than `2026.7.1-2` must fail the
  explicit compatibility command, not silently become a successful Phase 0
  result.
- Declared token fields may be absent in an emitted event, and declared counters
  do not prove provider accuracy; the report must keep declaration evidence and
  runtime evidence separate.
- Current SQLite stores have different owners, retention, and recovery meaning;
  documentation must not combine them or imply that the target learning store
  exists.

## Planned file map

| File | Responsibility |
| --- | --- |
| `.gitignore` | Exclude local GitNexus generated state from source status. |
| `.dockerignore` | Exclude the local graph database and caches from image context. |
| `scripts/lib/portability-audit.mjs` | Hold the reusable source-tree scan with explicit generated-directory exclusions. |
| `scripts/audit-portability.mjs` | Remain the thin repository-root CLI and preserve current output and exit behavior. |
| `scripts/test/portability-audit.test.mjs` | Prove that only `.gitnexus/` is excluded while source-path leaks still fail. |
| `scripts/test/repository-hygiene.test.mjs` | Pin source and container ignore rules. |
| `docs/RUNTIME_AND_DATA_OWNERSHIP.md` | Record current runtime, lifecycle, databases, filesystem state, and recovery ownership. |
| `scripts/test/runtime-ownership-documentation.test.mjs` | Prevent ownership documentation from losing required current-state facts. |
| `scripts/lib/openclaw-observability-probe.mjs` | Inspect a caller-supplied pinned OpenClaw installation without mutation. |
| `scripts/probe-openclaw-observability.mjs` | Emit a bounded, path-free JSON compatibility report and use nonzero exits for hard failures. |
| `scripts/test/openclaw-observability-probe.test.mjs` | Exercise supported, wrong-version, missing-hook, no-usage, and no-cost declaration fixtures. |
| `docs/OPENCLAW_COMPATIBILITY_SPIKE.md` | Record declaration evidence, command evidence, limits, and the Phase 1 input decision. |

No product plugin entrypoint, shared contract, database schema, runtime
configuration, compatibility patch, or package manifest changes in Phase 0.

---

### Task 1: Make local GitNexus state portable without weakening source scans

**State transition:** current portability defect to validated current-state
repair. This task does not change Friday runtime behavior.

**Files:**

- Create: `scripts/lib/portability-audit.mjs`
- Create: `scripts/test/portability-audit.test.mjs`
- Modify: `scripts/audit-portability.mjs`
- Modify: `scripts/test/repository-hygiene.test.mjs`
- Modify: `.gitignore`
- Modify: `.dockerignore`

**Interfaces:**

- Produces: `auditPortability(root: string | URL): Promise<readonly string[]>`.
- Preserves: `npm run audit:portability` prints exactly
  `Portability and secret audit passed.` on success and exits nonzero with
  file-and-line findings on failure.
- Excludes: the exact directory name `.gitnexus` at any scanned directory level,
  consistent with existing generated-directory exclusions.

- [ ] **Step 1: Confirm the reproduced failure and current worktree boundary**

Run from the implementation worktree:

```bash
git rev-parse --show-toplevel
git status --short
npm run audit:portability
```

Expected: the first command prints the implementation worktree, status is clean,
and the audit passes because this checkout does not yet have local GitNexus
state. Separately retain the planning evidence that the original checkout fails
only on the two generated GitNexus JSON files; do not run a write command there.

- [ ] **Step 2: Write the failing generated-state isolation tests**

Create `scripts/test/portability-audit.test.mjs` with temporary-directory tests
that import `auditPortability` and assert both behaviors:

```js
test("ignores generated GitNexus metadata containing a host-local path", async () => {
  // Create <temp>/.gitnexus/meta.json containing a synthetic non-example home path.
  assert.deepEqual(await auditPortability(tempRoot), []);
});

test("still reports the same host-local path in distributable documentation", async () => {
  // Create <temp>/docs/leak.md containing the same synthetic path.
  assert.match((await auditPortability(tempRoot)).join("\n"), /docs\/leak\.md:1/);
});
```

Extend `scripts/test/repository-hygiene.test.mjs` to require `.gitnexus/` in
`.gitignore` and `.gitnexus` in `.dockerignore`.

- [ ] **Step 3: Run the focused tests and observe the red state**

Run:

```bash
node --test scripts/test/portability-audit.test.mjs scripts/test/repository-hygiene.test.mjs
```

Expected: failure because `scripts/lib/portability-audit.mjs` and the two ignore
rules do not exist yet. This is the required red result.

- [ ] **Step 4: Check the existing scan symbol before refactoring**

Invoke against the verified current-worktree repository:

```text
impact({target: "walk", file_path: "scripts/audit-portability.mjs", direction: "upstream"})
```

Expected: the report identifies only the portability CLI flow. If risk is high,
critical, partial, or unknown, stop and report it instead of editing.

- [ ] **Step 5: Implement the narrow exclusion and reusable scanner**

Move the scan logic, unchanged in policy, into
`scripts/lib/portability-audit.mjs`. Add `.gitnexus` to its directory exclusion
set; do not exclude arbitrary dot-directories. Keep the CLI output contract in
`scripts/audit-portability.mjs`. Add `.gitnexus/` to `.gitignore` and
`.gitnexus` to `.dockerignore`.

- [ ] **Step 6: Run focused green checks and prove the original protection remains**

Run:

```bash
node --test scripts/test/portability-audit.test.mjs scripts/test/repository-hygiene.test.mjs
npm run audit:portability
```

Expected: all focused tests pass; the temporary `.gitnexus` fixture produces no
finding; the distributable documentation fixture produces the expected finding;
the repository audit prints its success line.

- [ ] **Step 7: Review and commit this repair**

Run `detect_changes({scope: "all", worktree: "<absolute implementation worktree>"})`.
Expected: only portability-audit and ignore-policy files are affected, with no
Friday runtime flow. Then run:

```bash
git diff --check
git add .gitignore .dockerignore scripts/audit-portability.mjs \
  scripts/lib/portability-audit.mjs scripts/test/portability-audit.test.mjs \
  scripts/test/repository-hygiene.test.mjs
git diff --cached --name-only
git commit -m "fix: isolate local gitnexus metadata"
```

Expected staged paths: exactly the six paths listed above.

**Rollback:** Revert this task's commit. If a local index exists, leave it
untouched during source rollback; remove it only with the scoped GitNexus clean
command in Task 2 when intentionally rebuilding the index.

---

### Task 2: Build and verify a current-checkout GitNexus index

**State transition:** stale/untrusted local metadata to validated local tooling
evidence. `.gitnexus/` remains generated, ignored, and uncommitted.

**Files:**

- Generated and ignored: `.gitnexus/**`
- No tracked file changes

**Interfaces:**

- Consumes: the exact active worktree realpath and `git rev-parse HEAD`.
- Produces: a local GitNexus metadata record whose `repoPath` resolves to the
  active worktree and whose `lastCommit` equals the active commit.

- [ ] **Step 1: Capture immutable checkout identity before indexing**

Run:

```bash
pwd -P
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
```

Expected: both path commands identify the implementation worktree; HEAD is the
Task 1 commit; tracked status is clean.

- [ ] **Step 2: Remove only a stale index when one is present**

Run:

```bash
if test -f .gitnexus/run.cjs; then node .gitnexus/run.cjs status; fi
```

If status or `.gitnexus/meta.json` names another realpath or commit, run:

```bash
node .gitnexus/run.cjs clean --force
```

Expected: only this worktree's generated `.gitnexus` state is removed. Never
copy the index from the original checkout and never delete a broader directory.

- [ ] **Step 3: Create the index with a pinned transient CLI**

Run:

```bash
npx -y gitnexus@1.6.12 analyze --force
```

Expected: exit zero and creation of `.gitnexus/meta.json` plus
`.gitnexus/run.cjs`; `package.json` and `package-lock.json` remain unchanged.

- [ ] **Step 4: Verify path, commit, and graph readability**

Run:

```bash
node .gitnexus/run.cjs status
node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync, realpathSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  const meta = JSON.parse(readFileSync(".gitnexus/meta.json", "utf8"));
  assert.equal(realpathSync(meta.repoPath), realpathSync(process.cwd()));
  assert.equal(meta.lastCommit, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.ok(meta.stats.nodes > 0);
  assert.ok(meta.stats.edges > 0);
  assert.ok(meta.stats.processes > 0);
'
```

Expected: status reports a usable index and every assertion passes. Counts are
recorded as evidence, not hard-coded as a permanent contract.

- [ ] **Step 5: Prove the generated index is isolated and portable**

Run:

```bash
npm run audit:portability
git check-ignore -v .gitnexus/meta.json .gitnexus/run.cjs
git status --short
git status --ignored --short .gitnexus
```

Expected: portability passes; both generated files resolve to the `.gitnexus`
ignore policy; tracked status remains clean; ignored status identifies only the
local generated directory.

**Rollback:** Run `node .gitnexus/run.cjs clean --force` from this worktree. This
removes the disposable local graph and registry entry without changing source.
Recreate it with the pinned analyze command before any later impact claim.

---

### Task 3: Document current runtime and data ownership

**State transition:** source-confirmed facts to validated, reviewable current-state
documentation. The target `friday-learning.sqlite` remains explicitly absent.

**Files:**

- Create: `docs/RUNTIME_AND_DATA_OWNERSHIP.md`
- Create: `scripts/test/runtime-ownership-documentation.test.mjs`

**Interfaces:**

- Consumes: current source entrypoints, `api.runtime.state.resolveStateDir()`,
  configuration examples, and rollback documentation.
- Produces: an ownership matrix with owner, location source, stored data,
  lifecycle, recovery rule, and evidence state for each runtime or store.

- [ ] **Step 1: Write the failing documentation contract test**

Create `scripts/test/runtime-ownership-documentation.test.mjs` using
`node:test` and `node:assert/strict`. It must require these exact facts from
`docs/RUNTIME_AND_DATA_OWNERSHIP.md`:

```text
OpenClaw Gateway
Security Shield
friday-security.sqlite
Git Adapter
friday-cache.sqlite
Jira Adapter
friday-jira.sqlite
Slack Recovery
friday-slack-watchdog.json
api.runtime.state.resolveStateDir()
cacheDir
friday-learning.sqlite
Target, not current
```

It must also require headings `State labels`, `Runtime ownership`, `Database
ownership`, `Filesystem ownership`, `Recovery boundaries`, and `Evidence
limits`.

- [ ] **Step 2: Run the focused test and observe the red state**

Run:

```bash
node --test scripts/test/runtime-ownership-documentation.test.mjs
```

Expected: failure because the ownership document does not exist.

- [ ] **Step 3: Write the ownership document from current source**

Document these current facts without changing them:

- OpenClaw owns Slack ingress, model-turn orchestration, lifecycle dispatch,
  plugin registration, and the resolved state directory.
- Security Shield owns `friday-security.sqlite`; it stores hashed identifiers,
  bounded reason codes, retention-managed audit rows, and a local salt.
- Git Adapter owns `friday-cache.sqlite`; it stores namespaced, bounded,
  expiring, redacted PR snapshot cache entries and may fall back to controlled
  fetch when cache access fails.
- Jira Adapter owns `friday-jira.sqlite`; it stores structured drafts,
  authorization binding, idempotency, creation reconciliation, and link-delivery
  state, not raw Slack transcripts.
- Slack Recovery owns `friday-slack-watchdog.json` on supported macOS hosts; it
  is optional watchdog state, not an application database.
- `paths.cacheDir` owns Git mirrors and validator caches separately from
  OpenClaw's state directory.
- `friday-learning.sqlite` is target architecture and does not exist in Phase 0.

For each row, cite the repository file that establishes the fact. Mark source
facts `Current`, the commands run in this task `Validated`, and live behavior
`Not runtime-proven` unless a real probe was executed.

- [ ] **Step 4: Run the focused test**

Run:

```bash
node --test scripts/test/runtime-ownership-documentation.test.mjs
```

Expected: one passing test and no generated runtime state.

- [ ] **Step 5: Review and commit the ownership documentation**

Run `detect_changes({scope: "all", worktree: "<absolute implementation worktree>"})`.
Expected: documentation plus its documentation-contract test only, with no
product execution flow affected. Then run:

```bash
git diff --check
git add docs/RUNTIME_AND_DATA_OWNERSHIP.md \
  scripts/test/runtime-ownership-documentation.test.mjs
git diff --cached --name-only
git commit -m "docs: record runtime and data ownership"
```

Expected staged paths: exactly the two paths listed above.

**Rollback:** Revert this task's commit. No database or runtime state is created,
migrated, deleted, or restored by this task.

---

### Task 4: Run a bounded pinned-OpenClaw lifecycle and usage spike

**State transition:** unverified design question to validated declaration-level
compatibility result. Phase 0 does not add production telemetry.

**Files:**

- Create: `scripts/lib/openclaw-observability-probe.mjs`
- Create: `scripts/probe-openclaw-observability.mjs`
- Create: `scripts/test/openclaw-observability-probe.test.mjs`
- Create: `docs/OPENCLAW_COMPATIBILITY_SPIKE.md`

**Interfaces:**

- Produces:
  `inspectOpenClawObservability({ executablePath, expectedVersion }): Promise<OpenClawProbeReport>`.
- CLI input: `--executable <absolute path>` is optional and defaults to the
  `openclaw` executable resolved from `PATH`; expected version is fixed at
  `2026.7.1-2`.
- CLI output: bounded JSON containing version, hook names, field-name lists,
  evidence class, and conclusions. It contains no installation path, prompt,
  message, token value, credential, or runtime payload.
- CLI exits: `0` for a pinned installation with readable declarations, `2` for
  missing executable, `3` for wrong version, and `4` for unreadable or
  structurally inconclusive declarations.

- [ ] **Step 1: Write failing probe tests with synthetic package fixtures**

Create temporary fake OpenClaw package roots and test all five cases:

1. exact `2026.7.1-2`, all lifecycle hook names, `agent_end` base fields, and
   `llm_output.usage` token counters;
2. wrong package version returns the version-mismatch classification;
3. missing `llm_output` returns the inconclusive classification;
4. `llm_output` without `usage` reports token telemetry unavailable;
5. hooks without a cost field report hook-level cost telemetry unavailable.

Assertions must compare normalized field-name arrays and evidence labels; do not
assert hashed vendor filenames.

- [ ] **Step 2: Run the focused test and observe the red state**

Run:

```bash
node --test scripts/test/openclaw-observability-probe.test.mjs
```

Expected: failure because the probe module does not exist.

- [ ] **Step 3: Implement the smallest read-only declaration inspector**

Resolve the executable with `realpath`, read its adjacent `package.json`, glob
only adjacent `dist/**/*.d.ts`, and extract the declarations for:

```text
PluginHookAgentContext
PluginHookAgentEndEvent
PluginHookModelCallStartedEvent
PluginHookModelCallEndedEvent
PluginHookLlmInputEvent
PluginHookLlmOutputEvent
```

Report only declared property names. Do not load runtime configuration, session
files, logs, prompts, messages, credentials, or provider account data. Do not
edit `types/openclaw-plugin-sdk.d.ts`; this spike observes the vendor contract
and does not make that contract a Friday production interface.

- [ ] **Step 4: Run fixture tests and the pinned-host probe**

Run:

```bash
node --test scripts/test/openclaw-observability-probe.test.mjs
node scripts/probe-openclaw-observability.mjs --json > /tmp/friday-openclaw-probe.json
node -e '
  const r = require("/tmp/friday-openclaw-probe.json");
  if (r.version !== "2026.7.1-2") process.exit(1);
  if (r.evidence !== "validated-declarations") process.exit(1);
  if (!r.hooks.agent_end.declared || !r.hooks.llm_output.declared) process.exit(1);
'
```

Expected: fixture tests pass; the live read-only declaration probe exits zero;
the report identifies the pinned version, `agent_end`, and `llm_output`. On the
currently inspected contract, token counters are declared on `llm_output.usage`,
not `agent_end`, and hook-level cost is unavailable. Delete the temporary JSON
after the assertions:

```bash
rm /tmp/friday-openclaw-probe.json
```

The deletion is limited to the explicit disposable report created by the prior
command.

- [ ] **Step 5: Write the spike report with evidence limits**

In `docs/OPENCLAW_COMPATIBILITY_SPIKE.md`, record:

- exact pinned versions and commands;
- lifecycle hooks and declared fields found by the probe;
- token counters as declaration-validated only;
- hook-level cost as unavailable in the inspected contract;
- real event emission, provider accuracy, retry aggregation, and monetary cost
  as not runtime-proven;
- the Phase 1 input: instrument no field until a redacted controlled turn proves
  its emitted shape, and never record prompt or message content by default.

The report must not propose a new OpenClaw event shape or modify Security Shield.

- [ ] **Step 6: Run focused checks and commit the spike**

Run:

```bash
node --test scripts/test/openclaw-observability-probe.test.mjs
npm run audit:portability
git diff --check
```

Then run `detect_changes({scope: "all", worktree: "<absolute implementation worktree>"})`.
Expected: only the read-only development probe, its tests, and its report are
affected; no production runtime flow is affected. Stage and commit:

```bash
git add scripts/lib/openclaw-observability-probe.mjs \
  scripts/probe-openclaw-observability.mjs \
  scripts/test/openclaw-observability-probe.test.mjs \
  docs/OPENCLAW_COMPATIBILITY_SPIKE.md
git diff --cached --name-only
git commit -m "test: probe pinned openclaw observability"
```

Expected staged paths: exactly the four paths listed above.

**Rollback:** Revert this task's commit. The probe does not modify the installed
runtime. If the pinned installation is missing or different, preserve the
nonzero result as evidence and stop; do not install, upgrade, patch, or configure
OpenClaw as part of this task.

---

### Task 5: Run the Phase 0 exit gate and produce the handoff

**State transition:** implemented Phase 0 repairs to validated repository
baseline. Runtime proof remains limited to explicitly executed probes.

**Files:**

- Modify only if evidence changed: `docs/RUNTIME_AND_DATA_OWNERSHIP.md`
- Modify only if evidence changed: `docs/OPENCLAW_COMPATIBILITY_SPIKE.md`

- [ ] **Step 1: Run every focused Phase 0 check together**

Run:

```bash
node --test scripts/test/portability-audit.test.mjs \
  scripts/test/repository-hygiene.test.mjs \
  scripts/test/runtime-ownership-documentation.test.mjs \
  scripts/test/openclaw-observability-probe.test.mjs
npm run audit:portability
node .gitnexus/run.cjs status
```

Expected: all focused tests pass, portability passes with `.gitnexus` present,
and GitNexus reports the active worktree index.

- [ ] **Step 2: Run the complete repository gate**

Run each required command separately so failures are attributable:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit zero. This proves source validation only; it does not
prove deployment, Slack connectivity, provider billing, or a real model event.

- [ ] **Step 3: Run documentation-quality scans**

Run:

```bash
BAN_PATTERN='TO''DO|TB''D|place''holder|implement la''ter|fill in det''ails'
if rg -n -i "$BAN_PATTERN" docs/RUNTIME_AND_DATA_OWNERSHIP.md \
  docs/OPENCLAW_COMPATIBILITY_SPIKE.md; then exit 1; fi
if rg -n '[[:blank:]]+$' docs/RUNTIME_AND_DATA_OWNERSHIP.md \
  docs/OPENCLAW_COMPATIBILITY_SPIKE.md; then exit 1; fi
```

Expected: both scans produce no matches and exit zero.

- [ ] **Step 4: Verify final index identity and change scope**

Run the Task 2 path/commit assertion again after the final source commit, then
run:

```text
detect_changes({scope: "compare", base_ref: "main", worktree: "<absolute implementation worktree>"})
```

Expected: the index matches the final HEAD; changed flows are limited to
development audits/tests and documentation; there is no Security Shield, Git
Adapter, Jira Adapter, Slack Recovery, model-facing tool, or runtime-config
behavior change. If the final commit made the index stale, rerun:

```bash
npx -y gitnexus@1.6.12 analyze --force
```

Then repeat the identity assertion and `detect_changes` call.

- [ ] **Step 5: Inspect repository state and ignored artifacts**

Run:

```bash
git diff --check main...HEAD
git status --short
git status --ignored --short
git log --oneline main..HEAD
```

Expected: no diff-check errors; tracked status is clean; `.gitnexus/`, build
outputs, and dependency directories may appear only as ignored; the branch log
contains the three scoped Phase 0 commits.

- [ ] **Step 6: Hand ownership back with an evidence ledger**

Report four separate sections:

1. **Implemented:** portability isolation, current-checkout indexing procedure,
   ownership documentation, and read-only OpenClaw compatibility probe.
2. **Validated:** exact commands, exit codes, test counts, active index path and
   commit match, and declaration-level hook findings.
3. **Runtime-proven:** only observations from commands that exercised a configured
   Friday runtime; otherwise state `none`.
4. **Unverified/target:** real hook emission and token accuracy, provider cost,
   and all Phase 1-or-later architecture.

Include rollback commits and stop. Do not begin observability implementation,
runtime setup, deployment, or another roadmap phase.

**Rollback:** Revert the three Phase 0 commits in reverse order. Clean the local
index with `node .gitnexus/run.cjs clean --force` only if local tooling state also
needs removal. Existing runtime databases and OpenClaw installation remain
untouched throughout.
