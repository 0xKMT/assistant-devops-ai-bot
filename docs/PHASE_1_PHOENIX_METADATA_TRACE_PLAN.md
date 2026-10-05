# Phase 1 Phoenix Metadata and Trace Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show bounded model, provider, content-shape, event, and status metadata in Phoenix and make spans from one trusted container turn share their actual trace ID.

**Architecture:** The pinned OpenClaw gateway emits OTLP to the private Collector. The Collector retains only reviewed metadata and actual parent spans; a hash-pinned OpenClaw compatibility patch is made only after a diagnostic gate identifies the missing trusted parent in the pinned release. Phoenix remains a diagnostic store, never a source of authorization truth.

**Tech Stack:** Node.js >=24, npm >=11, ESM, `node:test`, Docker Compose v2, OpenClaw `2026.7.1-2`, Collector Contrib `0.161.0`, Phoenix `version-20.15.0-nonroot`.

**Spec:** `docs/PHASE_1_PHOENIX_METADATA_TRACE_DESIGN.md`

## Global Constraints

- Container Edition only. Do not change native/macOS setup, Security Shield, model-facing tools, read-only review tools, Jira approval, or the three Friday SQLite stores.
- Add no dependency, no second telemetry SDK, and no invented OpenClaw event/interface. Keep all `captureContent` switches false and OTLP logs and metrics disabled.
- Never export prompt, message, assistant, system-prompt, repository, tool-input/output, credential, raw error, request-ID hash, local path, or raw runtime-config values.
- Keep the Collector private and fail closed. Do not delete or rewrite historical Phoenix data.
- Before editing an indexed function, run GitNexus `impact({target:"<function>",direction:"upstream"})` and report callers/processes/risk; warn before HIGH/CRITICAL edits. The current index is stale, so revalidate `repoPath`, `lastCommit`, and coverage and use pinned source for any unindexed vendor function. Run `detect_changes()` before each commit, but do not interpret an empty stale-index result as proof of no impact.
- No runtime-mutating setup or deployment command is a source-validation shortcut. Gateway cutover and a live Slack turn require separate operator approval after source and image gates pass. Do not merge or push.

## Review Focus

1. `gen_ai.system` without `gen_ai.provider.name` must produce the correct bounded provider (Task 1 fixture).
2. A configured primary or fallback model must stay named while an arbitrary model becomes `other` (Task 1 fixture).
3. A malicious event name, event attribute, raw status, or malformed prompt count must not survive export (Task 1 fixture).
4. A child whose harness parent was filtered must regain the actual parent without any ID rewriting (Task 1 fixture and Task 4 trace check).
5. A trusted usage event with no resolvable same-run parent must not be attached to a different turn (Tasks 2 and 3 tests).

## File map and decision gate

| Path | Responsibility |
| --- | --- |
| `container/otel-collector.yaml` | Exact span/event allowlists, metadata normalization, content-shape integers, categorical status. |
| `scripts/test/collector-privacy.test.mjs` | Disposable post-Collector OTLP sentinel and parent-relationship assertions. |
| `scripts/test/openclaw-trace-context.test.mjs` | Pinned bundle/hash and trusted trace-propagation fixture; selects the source patch branch. |
| `scripts/openclaw-trace-probe.mjs` | Hash-verified, enum-only diagnostic transform for a temporary probe image. |
| `container/Dockerfile.trace-probe` | Temporary image derived from the reviewed Friday gateway image; never used by the normal build. |
| `compose.trace-probe.yaml` | Gateway-image override used only during the separately approved diagnostic window. |
| `compat/openclaw-trace/patches.mjs` | One deterministic, exact-anchor vendor transform selected by Task 2. |
| `compat/openclaw-trace/manifest.json` | Pinned release, bundle path, preimage and result SHA-256 hashes. |
| `scripts/openclaw-trace-compat.mjs` | Check/apply wrapper; no write in check mode, fail on unknown bytes. |
| `Dockerfile` | Apply verified patch to the pinned image at build time only. |
| `scripts/test/container-observability.test.mjs` | Compose/image integration and no-content configuration assertions. |
| `docs/CONTAINER_SETUP.md` | Controlled validation/cutover, privacy evidence, rollback. |

The source patch is conditional, not a license to guess. Task 2 must produce
one of three outcomes: `missing_result_trace`, `lost_trusted_parent`, or
`collector_only`. `collector_only` skips Task 3. An unclassified result stops
execution for a plan revision; it is not treated as success.

## Task 1: Collector metadata and retained parent span

**Files:** Modify `container/otel-collector.yaml`, `scripts/test/collector-privacy.test.mjs`.

**Interfaces:** OTLP/HTTP receiver `:4318`; existing `filter/known` then `transform/privacy`; Phoenix exporter unchanged. Model IDs reviewed for this container: `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-sol`. The current deployed primary/fallback list was inspected as model-ID fields only; do not print the full OpenClaw configuration.

- [ ] **Step 1: Confirm the model allowlist and write the failing post-Collector fixture.** Run `docker exec friday-friday-gateway-1 node -e 'const c=require("/tmp/openclaw-observability.json");const a=new Set(["openai/gpt-5.6-luna","openai/gpt-5.6-terra","openai/gpt-5.6-sol"]);const m=c.agents?.defaults?.model;const v=[m?.primary,...(m?.fallbacks??[])];if(v.length!==3||v.some(x=>!a.has(x)))process.exit(1)'`. Expected exit 0 and no output; if not, stop and review the new model IDs privately before changing the allowlist. Extend the existing OTLP JSON payload in `scripts/test/collector-privacy.test.mjs` with an `openclaw.harness.run` parent, a child `openclaw.run`, an `openclaw.model.call` with `gen_ai.system=openai`, each of the three allowed model IDs and all six `openclaw.model_call.prompt.*` integer keys, an unknown model, an unknown event, and sentinel values in event attributes and raw status. Add assertions that only the known event name, empty event attributes, model/provider, nonnegative integer counts, categorical error status, and the unchanged parent/child IDs survive. Keep the existing secret-sentinel assertions. A representative assertion is:

  ```js
  assert.match(output, /gen_ai\.provider\.name: Str\(openai\)/);
  assert.match(output, /gen_ai\.request\.model: Str\(openai\/gpt-5\.6-luna\)/);
  assert.match(output, /openclaw\.model_call\.prompt\.input_messages_count: Int\(2\)/);
  assert.match(output, /openclaw\.provider\.request/);
  assert.doesNotMatch(output, /FRIDAY_SENTINEL_/);
  ```

- [ ] **Step 2: Prove red.** Run `node --test scripts/test/collector-privacy.test.mjs`. Expected: assertions for harness span, model/provider, prompt counts, safe event, and status fail against the current Collector policy; the existing privacy assertions continue to pass.
- [ ] **Step 3: Implement only the reviewed OTTL contract.** In `container/otel-collector.yaml`, add `openclaw.harness.run` to the span-name predicate. Add a `spanevent` filter for names other than `openclaw.provider.request`; replace the unconditional event deletion with a `spanevent` transform that clears every event attribute. Copy `gen_ai.system` into `gen_ai.provider.name` before `keep_keys`, only when the new key is absent. Keep the three model IDs above, the four existing token counters, and the six prompt-shape keys; delete prompt-shape keys outside `openclaw.model.call` or when not integer or negative. Clear the raw status message before setting a known `openclaw.errorCategory`, then a known `openclaw.errorCode`, or literal `error` when status code is ERROR. Leave success status empty. Retain the existing resource/scope allowlist, link and trace-state deletion, and no logs/metrics pipeline. The essential ordering is:

  ```yaml
  - 'set(span.attributes["gen_ai.provider.name"], span.attributes["gen_ai.system"]) where span.attributes["gen_ai.provider.name"] == nil and span.attributes["gen_ai.system"] != nil'
  - 'keep_keys(span.attributes, ["openclaw.channel", "openclaw.outcome", "openclaw.toolName", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens", "gen_ai.provider.name", "gen_ai.request.model", "openclaw.errorCategory", "openclaw.errorCode", "openclaw.model_call.prompt.input_messages_count", "openclaw.model_call.prompt.input_messages_chars", "openclaw.model_call.prompt.system_prompt_chars", "openclaw.model_call.prompt.tool_definitions_count", "openclaw.model_call.prompt.tool_definitions_chars", "openclaw.model_call.prompt.total_chars"])'
  - 'set(span.status.message, "")'
  ```

- [ ] **Step 4: Validate the exact Collector build.** Run `node --test scripts/test/collector-privacy.test.mjs` and `docker run --rm --mount type=bind,src="$PWD/container/otel-collector.yaml",dst=/etc/otelcol-contrib/config.yaml,readonly otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1 validate --config=/etc/otelcol-contrib/config.yaml`. Expected: all assertions pass and Collector reports valid configuration. A YAML parse error or sentinel leak is a stop, not a reason to relax the filter.
- [ ] **Step 5: Review and commit this independent slice.** Run `git diff --check`, `git status --short`, `git status --ignored --short`, and GitNexus `detect_changes()`. Stage only the two named files and commit `feat: retain safe Phoenix span metadata`. Rollback: revert this commit and restart only the Collector under a separately approved cutover; the running gateway and Phoenix volume are untouched by source validation.

## Task 2: Prove where trusted usage context is lost

**Files:** Create `scripts/test/openclaw-trace-context.test.mjs`, `scripts/openclaw-trace-probe.mjs`, `container/Dockerfile.trace-probe`, `compose.trace-probe.yaml`. Do not patch the live container or the normal `Dockerfile` in this task.

**Interfaces:** `patchTraceProbe(source, kind)` in `scripts/openclaw-trace-probe.mjs` returns `{ source, state }`, where `kind` is `host` or `plugin` and `state` is `patched` or `already-patched`. Read-only pinned paths inside the gateway image are `/app/dist/selection-JInn13lc.js`, `/app/dist/agent-runner.runtime-DtdxZiBX.js`, and `/app/extensions/diagnostics-otel/src/service.ts`. The observed preimage hashes are respectively `ccff13111aa60369ac9d88b526a58a7df1f733f1d99d205c01c6186036957e66`, `37e2d3f40651107f5fa9abe76ccc9b2345497f952991dec50a2d18eaf8c35c42`, and `91e602a187a0da68496d19671c8a6f55fa34a56369f0da2a239bcd8a33600c4a`. Reconfirm against the pinned base image; a mismatch stops this plan.

- [ ] **Step 1: Write red pin and probe tests.** In `scripts/test/openclaw-trace-context.test.mjs`, use `docker run --rm --entrypoint sha256sum ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac1 /app/dist/selection-JInn13lc.js /app/dist/agent-runner.runtime-DtdxZiBX.js /app/extensions/diagnostics-otel/src/service.ts` and assert the three hashes above. With small synthetic source strings, assert the probe transform accepts each exact anchor once, refuses a duplicate/missing anchor, writes only `present`/`absent` and `resolved_parent`/`lost_trusted_parent`/`missing_event_trace`, and is idempotent. Run `node --test scripts/test/openclaw-trace-context.test.mjs`; expected missing-module failure before creating the transform.
- [ ] **Step 2: Build an enum-only probe image.** Implement `scripts/openclaw-trace-probe.mjs` as an exact-hash, exact-anchor source transform. Immediately before the pinned host's `emitTrustedDiagnosticEvent({ type: "model.usage" ... })`, insert `process.stderr.write("FRIDAY_TRACE_PROBE_RESULT=" + (runResult.diagnosticTrace ? "present" : "absent") + "\n")`. In `recordModelUsage`, compute `const parentContext = activeTrustedParentContext(evt, metadata)` once, write `FRIDAY_TRACE_PROBE_PARENT=` plus `missing_event_trace` if no trusted parent ID, `lost_trusted_parent` if no resolved context, or `resolved_parent`, and pass that same `parentContext` to `spanWithDuration`. Do not print event contents or IDs. `container/Dockerfile.trace-probe` must derive from `friday:phase1-bundled-otel`, copy the probe script to `/tmp`, run it as root against only the two verified files, remove the script, and restore `USER node`. `compose.trace-probe.yaml` must override only `friday-gateway.image` to `friday:trace-probe` and set `build: null`; it must not change volumes, ports, secrets, or Collector/Phoenix services. The image and override must have these shapes:

  ```dockerfile
  FROM friday:phase1-bundled-otel
  USER root
  COPY scripts/openclaw-trace-probe.mjs /tmp/openclaw-trace-probe.mjs
  RUN node /tmp/openclaw-trace-probe.mjs --apply && rm /tmp/openclaw-trace-probe.mjs
  USER node
  ```

  ```yaml
  services:
    friday-gateway:
      image: friday:trace-probe
      build: null
  ```

  Run `node --test scripts/test/openclaw-trace-context.test.mjs` and `docker build -f container/Dockerfile.trace-probe -t friday:trace-probe .`; expected tests and build pass, with the original image and running container unchanged.
- [ ] **Step 3: Classify a new controlled turn.** Obtain separate approval for one diagnostic gateway cutover. Run `docker inspect --format '{{.Image}}' friday-friday-gateway-1` and retain the image ID in private operator notes. Run `sh container/compose.sh -f compose.observability.yaml -f compose.trace-probe.yaml --profile observability config --quiet`, then the same prefix with `up -d --no-deps friday-gateway`; confirm `docker inspect --format '{{.State.Health.Status}}' friday-friday-gateway-1` returns `healthy` before sending one owner-controlled read-only Slack turn. Read only projected probe lines with `docker logs --since 5m friday-friday-gateway-1 2>&1 | rg '^FRIDAY_TRACE_PROBE_(RESULT|PARENT)='`; do not copy other log lines into a report. If result is `absent` despite a concurrent `openclaw.run`, choose `missing_result_trace`. If result is `present` and parent is `lost_trusted_parent`, choose `lost_trusted_parent`. If result is `present` and parent is `resolved_parent` while Phoenix still lacks the parent, choose `collector_only`. Any other combination, multiple interleaved turns, or a failed health check stops Task 3. Restore with `sh container/compose.sh -f compose.observability.yaml --profile observability up -d --no-deps friday-gateway` and assert its image ID equals the privately recorded value; leave Friday and Phoenix volumes intact. The probe image must not remain active after classification.
- [ ] **Step 4: Review and commit the reproducible probe.** Run `node --test scripts/test/openclaw-trace-context.test.mjs`, `git diff --check`, `git status --short`, and GitNexus `detect_changes()`; stage only the four files named in this task and commit `test: locate pinned OpenClaw trace gap`. Expected: tests pass against the pinned image and the normal gateway image remains unchanged. Rollback: revert this commit; keep the prior gateway image in service.

## Task 3: Patch only the proven pinned OpenClaw boundary

**Files:** Create `compat/openclaw-trace/patches.mjs`, `compat/openclaw-trace/manifest.json`, `scripts/openclaw-trace-compat.mjs`; modify `scripts/test/openclaw-trace-context.test.mjs`, `Dockerfile`, `scripts/test/container-observability.test.mjs`. Skip the task entirely on `collector_only`.

**Interfaces:** `patchMissingResultTrace(source)` and `patchRetainedTrustedParent(source)` each return `{ source, state }`, where `state` is `patched` or `already-patched`; only the selected function is invoked. `scripts/openclaw-trace-compat.mjs` accepts `--apply` and `--no-backup`; check mode is the default. Unknown hashes, duplicate/missing anchors, partial patches, and untrusted trace context fail closed. No runtime config or external plugin package changes.

- [ ] **Step 1: Run impact before editing vendor functions.** Run GitNexus upstream impact for `runAgentHarnessLifecycleAttempt`, `activeTrustedParentContext`, and `recordModelUsage`. Because the vendor bundle is not reliably covered by the stale repository graph, record any `not found` result as `unindexed`, not `none`; use the exact pinned source call chain inspected in Task 2. Warn the user before a HIGH/CRITICAL result.
- [ ] **Step 2: Write red compatibility tests.** Extend `scripts/test/openclaw-trace-context.test.mjs` with fixed source fixtures for the selected outcome. Assert one exact upstream anchor, idempotent second application, rejection of a partial patch, and no change to the other two pinned files. Test a same-run synthetic trace retains its original trace ID and parent; a missing/untrusted parent must not attach to another run. Run `node --test scripts/test/openclaw-trace-context.test.mjs`. Expected: missing transform/module failure.
- [ ] **Step 3: Implement the selected transform.** For `missing_result_trace`, the only replacement in `/app/dist/selection-JInn13lc.js` is `withFallbackDiagnosticTrace(result, activeHarnessTrace)` to `withFallbackDiagnosticTrace(result, agentRunTrace ?? activeHarnessTrace)`; do not alter `createChildDiagnosticTraceContext` or event payload shape. For `lost_trusted_parent`, modify only `/app/extensions/diagnostics-otel/src/service.ts`: remove the zero-delay `waitForDiagnosticEventsDrained().then(cleanup, cleanup)` cleanup and change `RETAINED_TRUSTED_SPAN_CONTEXT_TIMEOUT_MS` from `5_000` to `30_000`. Keep the existing 1024-entry cap, trusted-only lookup, owner match, and trace-ID match. The tests must prove a different `runId`, different trace ID, or untrusted metadata cannot reuse it, and that an ended parent remains available before 30 seconds but not after. Do not apply both transforms. The wrapper follows `scripts/slack-compat.mjs`: verify release and SHA-256 of all bytes before any write, compute and verify the expected after-hash, and use same-directory temporary rename. Record the actual after-hash in `compat/openclaw-trace/manifest.json` by running `shasum -a 256` on the transformed disposable copy; do not use a wildcard hash. The exact replacements are:

  ```js
  const hostBefore = "withFallbackDiagnosticTrace(result, activeHarnessTrace)";
  const hostAfter = "withFallbackDiagnosticTrace(result, agentRunTrace ?? activeHarnessTrace)";
  const pluginTimeoutBefore = "const RETAINED_TRUSTED_SPAN_CONTEXT_TIMEOUT_MS = 5_000;";
  const pluginTimeoutAfter = "const RETAINED_TRUSTED_SPAN_CONTEXT_TIMEOUT_MS = 30_000;";
  // The plugin branch also removes exactly the drainHandle=setTimeout block
  // ending in waitForDiagnosticEventsDrained().then(cleanup, cleanup).
  ```
- [ ] **Step 4: Wire the image build and verify fail-closed behavior.** `Dockerfile` copies only the compatibility files and invokes `node /opt/friday/source/scripts/openclaw-trace-compat.mjs --apply --no-backup` after the pinned base image is selected and before `chmod -R a-w /opt/friday`. Test check mode on the base image, apply mode on a disposable image build, second apply idempotency, and wrong-hash refusal. Run `node --test scripts/test/openclaw-trace-context.test.mjs scripts/test/container-observability.test.mjs`; expected all pass. Do not install a package or patch the live container.
- [ ] **Step 5: Review and commit the selected patch.** Run `git diff --check`, `git status --short`, `git status --ignored --short`, and GitNexus `detect_changes()`; stage only the six paths in this task and commit `fix: preserve pinned OpenClaw usage trace context`. Rollback: use the previous reviewed gateway image; the base image, runtime state, and databases are not modified by the build-time patch.

## Task 4: Full gate, operator guide, and controlled cutover

**Files:** Modify `docs/CONTAINER_SETUP.md`, `scripts/test/container-observability.test.mjs`; no other tracked file unless a prior failing test names a precise defect.

**Interfaces:** Existing `compose.yaml` plus `compose.observability.yaml`; the running gateway image and Collector config remain rollback targets. This task does not authorize merge, push, data deletion, or a new model-facing operation.

- [ ] **Step 1: Add a red documentation check.** Add a case to `scripts/test/container-observability.test.mjs` asserting the guide names the metadata-only fields, empty content panel expectation, trusted trace-ID/parent check, privacy sentinel check, and separate cutover/rollback gates. Run `node --test scripts/test/container-observability.test.mjs`; expected failure before the guide edit.
- [ ] **Step 2: Update only the container guide.** In `docs/CONTAINER_SETUP.md`, give exact source validation commands from Tasks 1 and 3, the deployment config command `sh container/compose.sh -f compose.observability.yaml --profile observability config --quiet`, and the distinction among Current, Validated, Target, and Runtime-proven. State that no raw content appears in Phoenix and that historical traces are not repaired. Keep secret rendering/setup steps behind their existing operator workflow.
- [ ] **Step 3: Run the complete local gate.** Run `node --test scripts/test/collector-privacy.test.mjs scripts/test/openclaw-trace-context.test.mjs scripts/test/container-observability.test.mjs`, `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, `git status --short`, and `git status --ignored --short`. Expected: every command exits 0, only reviewed tracked paths differ, and ignored build/runtime files are not staged. A passing build is not deployment proof.
- [ ] **Step 4: Request and perform a separate runtime cutover.** After the operator approves the exact window, run `docker inspect --format '{{.Image}}' friday-friday-gateway-1` and `shasum -a 256 container/otel-collector.yaml` and retain those identifiers privately. Preserve the old image under a rollback tag with `docker tag friday:phase1-bundled-otel friday:pre-phoenix-metadata-rollback`; do not remove it. Build with `sh container/compose.sh -f compose.observability.yaml --profile observability build friday-gateway`, validate the Collector with the Task 1 command, then run `sh container/compose.sh -f compose.observability.yaml --profile observability up -d --no-deps otel-collector friday-gateway`. Check `docker inspect --format '{{.State.Health.Status}}' friday-friday-gateway-1` returns `healthy` and `curl -fsS -o /dev/null http://127.0.0.1:6006/` exits 0. Send one owner-controlled read-only Slack turn. Inspect `http://127.0.0.1:6006/projects/UHJvamVjdDox/spans?timeRangeKey=15m` for only safe attributes, span names, parent/trace equality, event names, and status categories. Expected: configured model/provider visible; numeric prompt shape on emitted model-call span; no raw content/event attributes/status text; no dangling parent; one trace ID for the turn. If any check fails, run `FRIDAY_IMAGE_TAG=pre-phoenix-metadata-rollback sh container/compose.sh -f compose.observability.yaml --profile observability up -d --no-deps friday-gateway`, revert the Task 1 Collector commit and restart only `otel-collector`, leave Phoenix volume intact, and report Runtime-proven=false.
- [ ] **Step 5: Final review and commit documentation.** Run GitNexus `detect_changes()`, `git diff --check`, and `git status --short`; stage only `docs/CONTAINER_SETUP.md` and `scripts/test/container-observability.test.mjs` and commit `docs: verify Phoenix metadata cutover`. Do not merge or push. Rollback of source is the exact Task 1 and Task 3 commits; rollback of runtime uses the previously recorded image/config and never removes Friday or Phoenix volumes.

## Source references

- `docs/PHASE_1_PHOENIX_METADATA_TRACE_DESIGN.md` and `docs/PHASE_1_CONTAINER_OBSERVABILITY_DESIGN.md`.
- Pinned OpenClaw source in the reviewed image: `/app/dist/selection-JInn13lc.js`, `/app/dist/agent-runner.runtime-DtdxZiBX.js`, `/app/extensions/diagnostics-otel/src/service.ts`.
- [Collector filter processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/filterprocessor/README.md) documents span-event filtering; [transform processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/transformprocessor/README.md) documents span-event context and fail-closed `error_mode`.
