# Phase 1 Container Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one containerized Friday Slack-to-tool-to-response trace visible in local Phoenix without protected content, and provide a reproducible synthetic golden evaluation.

**Architecture:** A pinned OpenClaw diagnostics plugin emits OTLP/HTTP traces to a private Collector, whose default-deny transform exports to Phoenix. An opt-in Compose overlay uses a temporary OpenClaw config, leaving the persistent gateway config and plain Compose path unchanged. The evaluation runner reads tracked synthetic JSONL and performs deterministic assertions without external calls.

**Tech Stack:** Node.js >=24, npm >=11, ESM, `node:test`, Docker Compose v2, OpenClaw `2026.7.1-2`, `@openclaw/diagnostics-otel@2026.7.1`, OpenTelemetry Collector Contrib `0.161.0`, Phoenix `version-20.15.0-nonroot`.

**Spec:** `docs/PHASE_1_CONTAINER_OBSERVABILITY_DESIGN.md`

## Global Constraints

- Container Edition only; no native/macOS integration or Phase 2 learning/memory.
- No new model-facing tools, generic writes, deployment/cluster mutation, or authorization changes.
- Preserve Security Shield, read-only repository mounts, requester-bound Jira approval, and existing SQLite volumes.
- Default content capture is false for every OpenClaw switch; logs and metrics are disabled.
- Collector receiver is private; only the Phoenix UI may bind a loopback host port.
- Never commit credentials, raw runtime data, raw Slack content, local paths, or production identifiers.
- Every source-symbol edit requires GitNexus `impact` first; run `detect_changes` before each commit. If MCP index metadata disagrees with this worktree, use the explicit worktree path and do not treat a partial result as clean.
- No runtime-mutating setup/deployment command is a source-validation shortcut. Live proof is a separate, operator-controlled gate.

## Review Focus

1. A persistent `openclaw.json` containing unrelated plugin entries must remain byte-identical after opt-in config rendering (Task 1 test).
2. Malformed or missing source config must fail before gateway launch, without writing partial active config (Task 1 test).
3. An OTLP span with unexpected attributes, events, links, and status text must lose those fields before export (Task 2 synthetic Collector probe).
4. Plain Compose must not start Collector/Phoenix or activate diagnostics after an observability run (Tasks 1 and 2 tests).
5. A golden case with changed expected outcome or an unknown assertion must fail deterministically, not silently pass (Task 3 test).

## File map

| Path | Responsibility |
| --- | --- |
| `scripts/lib/observability-config.mjs` | Pure overlay of the reviewed OpenClaw diagnostics configuration. |
| `scripts/render-observability-config.mjs` | Read persistent config, write a private temporary config atomically. |
| `scripts/test/observability-config.test.mjs` | Overlay/default/path and failure tests. |
| `container/entrypoint.sh` | Opt-in temp-config rendering before `tini`; default path unchanged. |
| `Dockerfile` | Install the pinned official diagnostics plugin into the immutable image. |
| `compose.observability.yaml` | Opt-in gateway environment and private Collector/Phoenix services. |
| `container/otel-collector.yaml` | Receive, strip, and export traces only. |
| `scripts/test/container-observability.test.mjs` | Static Compose/Collector/image boundary checks. |
| `scripts/test/collector-privacy.test.mjs` | Isolated post-Collector sentinel probe using a disposable test container. |
| `eval/golden/container-v1.jsonl` | Versioned, synthetic baseline cases. |
| `scripts/lib/golden-eval.mjs` | Pure fixture schema and deterministic scoring. |
| `scripts/run-golden-eval.mjs` | Local JSONL runner; no network clients. |
| `scripts/test/golden-eval.test.mjs` | Good/bad cases and unknown-assertion tests. |
| `package.json` | `eval:golden` script only; no package dependency. |
| `docs/CONTAINER_SETUP.md` | Opt-in start/stop, privacy proof, rollback, state labels. |

## Task 1: Isolated gateway diagnostics configuration

**Files:** Create `scripts/lib/observability-config.mjs`, `scripts/render-observability-config.mjs`, `scripts/test/observability-config.test.mjs`; modify `container/entrypoint.sh`.

**Interfaces:** `observabilityConfig(base: object): object` returns a deep copy; `render(inputPath: string, outputPath: string): Promise<void>` writes mode `0600`. The Compose overlay in Task 2 sets `FRIDAY_OBSERVABILITY=1`; the entrypoint sets `OPENCLAW_CONFIG_PATH=/tmp/openclaw-observability.json` only after a successful render.

- [ ] **Step 1: Establish blast radius.** Run GitNexus `impact` upstream for the existing entrypoint/config-render symbols that will be edited. Record direct callers, affected flows, and risk; warn before edits if HIGH/CRITICAL. Compare the MCP repo path and commit with this worktree. Expected: no authorization-policy symbol is in the edit set.
- [ ] **Step 2: Write failing tests.** In `scripts/test/observability-config.test.mjs`, use `node:test` and `node:assert/strict` to assert that `observabilityConfig({ plugins: { allow: ["slack"], entries: { slack: { enabled: true } } } })` retains Slack, adds only `diagnostics-otel`, sets `diagnostics.otel` to `{ enabled:true, endpoint:"http://otel-collector:4318", protocol:"http/protobuf", serviceName:"friday-gateway", traces:true, metrics:false, logs:false, sampleRate:1, captureContent:{ enabled:false, inputMessages:false, outputMessages:false, toolInputs:false, toolOutputs:false, systemPrompt:false, toolDefinitions:false } }`, and does not mutate the input. Use a temp directory to verify `render` leaves the input bytes unchanged, outputs mode `0600`, and rejects invalid JSON or a missing input without creating an output file. Assert the plain entrypoint path does not set `OPENCLAW_CONFIG_PATH`.

  ```js
  const base = { plugins: { allow: ["slack"], entries: { slack: { enabled: true } } } };
  const before = JSON.stringify(base);
  const result = observabilityConfig(base);
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(result.plugins.allow, ["slack", "diagnostics-otel"]);
  assert.equal(result.diagnostics.otel.captureContent.systemPrompt, false);
  assert.equal(result.diagnostics.otel.logs, false);
  ```
- [ ] **Step 3: Prove red.** Run `node --test scripts/test/observability-config.test.mjs`. Expected: module-not-found or missing-export failure.
- [ ] **Step 4: Implement minimally.** `observabilityConfig` must use `structuredClone(base)`, append the baked plugin directory to `plugins.load.paths`, deduplicate `plugins.allow`, enable `plugins.entries["diagnostics-otel"]`, and set the exact diagnostics object above. `render` reads and parses the source before writing a same-directory temporary file with `{ mode: 0o600 }`, then renames it onto the output. Its CLI rejects missing paths. In `container/entrypoint.sh`, only when `FRIDAY_OBSERVABILITY=1`, run `node /opt/friday/source/scripts/render-observability-config.mjs /home/node/.openclaw/openclaw.json /tmp/openclaw-observability.json` and export `OPENCLAW_CONFIG_PATH=/tmp/openclaw-observability.json`; otherwise do neither. The baked plugin path is `/opt/friday/plugins/diagnostics-project/node_modules/@openclaw/diagnostics-otel`.

  ```js
  const pluginPath = "/opt/friday/plugins/diagnostics-project/node_modules/@openclaw/diagnostics-otel";
  const captureContent = Object.fromEntries([
    "enabled", "inputMessages", "outputMessages", "toolInputs",
    "toolOutputs", "systemPrompt", "toolDefinitions",
  ].map((key) => [key, false]));
  const otelSettings = {
    enabled: true, endpoint: "http://otel-collector:4318", protocol: "http/protobuf",
    serviceName: "friday-gateway", traces: true, metrics: false, logs: false,
    sampleRate: 1, captureContent,
  };
  export function observabilityConfig(base) {
    const next = structuredClone(base);
    next.plugins ??= {};
    next.plugins.load ??= {};
    next.plugins.load.paths = [...new Set([...(next.plugins.load.paths ?? []), pluginPath])];
    next.plugins.allow = [...new Set([...(next.plugins.allow ?? []), "diagnostics-otel"])];
    next.plugins.entries = { ...next.plugins.entries, "diagnostics-otel": { enabled: true } };
    next.diagnostics = { ...next.diagnostics, enabled: true, otel: otelSettings };
    return next;
  }
  ```
- [ ] **Step 5: Prove green and regressions.** Run `node --test scripts/test/observability-config.test.mjs scripts/test/jira-instance-config.test.mjs`. Expected: every test passes; no `prepare-instance.mjs` or persisted config behavior changes.
- [ ] **Step 6: Review and commit.** Run `git diff --check`, `git status --short`, and `git rev-parse --show-toplevel`; invoke GitNexus `detect_changes` with `scope: "all"` and both `repo` and `worktree` set to the resolved root. Stage only the four named files; commit `feat: isolate container observability config`. Rollback: revert this commit; the persistent OpenClaw config and Friday databases need no restoration.

## Task 2: Pinned private Collector and Phoenix profile

**Files:** Modify `Dockerfile`; create `compose.observability.yaml`, `container/otel-collector.yaml`, `scripts/test/container-observability.test.mjs`, `scripts/test/collector-privacy.test.mjs`.

**Interfaces:** Compose overlay sets the Task 1 environment switch. Gateway OTLP endpoint is `http://otel-collector:4318`; Collector exports to `http://phoenix:6006/v1/traces`. Only `127.0.0.1:6006:6006` is published for Phoenix.

- [ ] **Step 1: Write failing static tests.** Assert in `scripts/test/container-observability.test.mjs` that the overlay contains the opt-in gateway switch and private Collector/Phoenix services, no `ports` key on Collector, Phoenix's loopback port only, a Phoenix named volume, and digest-pinned images. Assert `compose.yaml` remains without a diagnostics switch or observability service. Assert `Dockerfile` pins `@openclaw/diagnostics-otel@2026.7.1`, and the Collector config has one traces pipeline, no logs/metrics pipeline, `error_mode: propagate`, and explicit sanitization of resource, scope, span, event, link, status, and trace-state fields.
- [ ] **Step 2: Prove red.** Run `node --test scripts/test/container-observability.test.mjs`. Expected: missing overlay/config test failure.
- [ ] **Step 3: Pin images and plugin.** Use the already resolved multi-arch manifests: `otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1` and `arizephoenix/phoenix:version-20.15.0-nonroot@sha256:f77e2d45a7ebf78d02b7a5fa179315ecd8aef7a57640a328d02f578e62964833`. Re-run `docker buildx imagetools inspect` on both tags; expected digest equality. `npm view @openclaw/diagnostics-otel@2026.7.1 dist.integrity peerDependencies --json` must show the recorded integrity `sha512-XXhMifYWTgoR6yFN4T3JkHxdPvQCe8k1cNZjVIgXNmk1svCdBWuALfQQicmpemlmWwauIQuHYgBURY6k63e+rw==` and peer `openclaw >=2026.7.1`. If any pin differs, stop this task and document the registry drift before editing.
- [ ] **Step 4: Implement the Compose/image slice.** Follow the existing Slack-plugin build pattern in `Dockerfile`: install `npm:@openclaw/diagnostics-otel@2026.7.1` under a disposable build state, copy the installed package tree to `/opt/friday/plugins/diagnostics-project`, then remove disposable state. Add `compose.observability.yaml` with gateway `FRIDAY_OBSERVABILITY=1`, a private `otel-collector` service mounting `container/otel-collector.yaml:ro`, and a `phoenix` service with a dedicated named `/mnt/data` volume and loopback UI port. Do not publish OTLP or change `compose.yaml`.
- [ ] **Step 5: Implement fail-closed Collector policy.** `container/otel-collector.yaml` must use an OTLP HTTP receiver on `0.0.0.0:4318`, a `transform/privacy` traces processor with `error_mode: propagate`, and OTLP HTTP export to Phoenix. Use OTTL `keep_keys` to retain only `service.name` on resources and the explicit span keys `openclaw.channel`, `openclaw.outcome`, `openclaw.toolName`, `gen_ai.tool.name`, `openclaw.errorCategory`, and `gen_ai.operation.name`; set scope attributes to empty; set `span.events`, `span.links`, and `span.trace_state` to nil/empty; clear `span.status.message`; keep only the documented constant OpenClaw span names. Reject all other span names in a `filter` processor before export. Do not configure logs or metrics receivers/exporters.

  ```yaml
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
  processors:
    filter/known:
      error_mode: propagate
      traces:
        span:
          - 'name != "openclaw.message.processed" and name != "openclaw.run" and name != "openclaw.tool.execution" and name != "openclaw.message.delivery" and name != "openclaw.model.call" and name != "openclaw.model.usage"'
    transform/privacy:
      error_mode: propagate
      trace_statements:
        - context: span
          statements:
            - 'keep_keys(resource.attributes, ["service.name"])'
            - 'keep_keys(instrumentation_scope.attributes, [])'
            - 'keep_keys(span.attributes, ["openclaw.channel", "openclaw.outcome", "openclaw.toolName", "gen_ai.tool.name", "openclaw.errorCategory", "gen_ai.operation.name"])'
            - 'set(span.events, nil)'
            - 'set(span.links, nil)'
            - 'set(span.trace_state, "")'
            - 'set(span.status.message, "")'
  exporters:
    otlphttp/phoenix:
      traces_endpoint: http://phoenix:6006/v1/traces
  service:
    pipelines:
      traces:
        receivers: [otlp]
        processors: [filter/known, transform/privacy]
        exporters: [otlphttp/phoenix]
  ```
- [ ] **Step 6: Validate configuration without starting Friday.** Run `node --test scripts/test/container-observability.test.mjs`, `FRIDAY_REPOSITORIES_DIR=/tmp docker compose -f compose.yaml -f compose.observability.yaml config --quiet`, and `docker run --rm -v "$PWD/container/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1 validate --config=/etc/otelcol-contrib/config.yaml`. Expected: tests pass, Compose valid, Collector reports valid config. Do not read or print real secret values.
- [ ] **Step 7: Prove post-Collector redaction.** Write `scripts/test/collector-privacy.test.mjs` to start the pinned Collector in a disposable Docker container on loopback port `14318`, with a temp config derived from `container/otel-collector.yaml` that replaces the Phoenix exporter with a `debug` exporter. Send OTLP/HTTP JSON to `http://127.0.0.1:14318/v1/traces` with a fixed trace ID and distinct `FRIDAY_SENTINEL_*` strings in span/resource/scope attributes, event, link, status message, and trace state. Capture only the post-processor debug export, assert the fixed trace ID and allowed outcome remain, and assert no sentinel remains. Stop the exact test container in `finally`; never use the user's Phoenix volume. Run `node --test scripts/test/collector-privacy.test.mjs`; expected pass and no lingering test container.
- [ ] **Step 8: Review and commit.** Run `git diff --check`, `git status --short`, and GitNexus `detect_changes` with `scope:"all"` and both `repo`/`worktree` set to the exact `git rev-parse --show-toplevel` result; stage only the five named files and commit `feat: add private container trace pipeline`. Rollback: revert this commit and stop the opt-in overlay; preserve the Phoenix volume unless separately approved for deletion.

## Task 3: Synthetic versioned golden evaluation

**Files:** Create `eval/golden/container-v1.jsonl`, `scripts/lib/golden-eval.mjs`, `scripts/run-golden-eval.mjs`, `scripts/test/golden-eval.test.mjs`; modify `package.json` scripts only.

**Interfaces:** `evaluateCase(row: object): { id:string, passed:boolean, failures:string[] }`; runner prints one JSON result per case plus a bounded summary and exits nonzero if any case fails.

- [ ] **Step 1: Write failing tests.** `scripts/test/golden-eval.test.mjs` must pass four synthetic cases with IDs `readonly-authorized`, `requester-denied`, `tool-bounded-error`, and `jira-unapproved`; change each expected outcome and assert failure; use assertion name `unknown` and assert rejection; assert duplicate IDs and mixed dataset versions fail; assert no runner import of `node:http`, Slack, Jira, or model SDK packages.
- [ ] **Step 2: Prove red.** Run `node --test scripts/test/golden-eval.test.mjs`. Expected: missing module failure.
- [ ] **Step 3: Implement the minimal evaluator.** Each JSONL row has `datasetVersion`, `id`, `observed`, and `assert`; both latter objects contain exactly `authorized` (boolean), `toolStatus` (`not_called`, `ok`, or `bounded_error`), and `jiraCreated` (boolean). `evaluateCase` compares exactly those three fields; reject unknown/missing keys and enum values. The four tracked cases must encode: authorized/ok/no Jira create; denied/not_called/no create; authorized/bounded_error/no create; authorized/not_called/no create. The CLI reads only the tracked path by default and exits 1 on failed assertions or invalid input. Add `"eval:golden": "node scripts/run-golden-eval.mjs"` to `package.json`; do not add dependencies.

  ```js
  const fields = ["authorized", "toolStatus", "jiraCreated"];
  export function evaluateCase(row) {
    const failures = fields.filter((field) => row.observed[field] !== row.assert[field]);
    return { id: row.id, passed: failures.length === 0, failures };
  }
  ```
- [ ] **Step 4: Prove green and reproducibility.** Run `node --test scripts/test/golden-eval.test.mjs`, then `npm run eval:golden` twice. Expected: four passing cases and byte-identical result output across the two invocations; no external call or runtime state change.
- [ ] **Step 5: Review and commit.** Run `git diff --check`, `git status --short`, and GitNexus `detect_changes` with `scope:"all"` and both `repo`/`worktree` set to the exact `git rev-parse --show-toplevel` result; stage only the five named files and commit `test: add synthetic container golden eval`. Rollback: revert this commit; no application database or Phoenix experiment is changed.

## Task 4: Operator guide, full gate, and runtime evidence

**Files:** Modify `docs/CONTAINER_SETUP.md`, `scripts/test/container-observability.test.mjs`; no other tracked file unless a prior task's test demonstrates a specific defect.

**Interfaces:** Document exact opt-in Compose overlay invocation and the different evidence levels. No command should display secrets or raw traces in a shared log.

- [ ] **Step 1: Write documentation assertions.** Add a `node:test` case to `scripts/test/container-observability.test.mjs` checking that `docs/CONTAINER_SETUP.md` names the overlay, localhost Phoenix URL, opt-out command, separate Phoenix volume, privacy inspection, and `Runtime-proven` gate. Run `node --test scripts/test/container-observability.test.mjs`; expected failure before documentation edit.
- [ ] **Step 2: Document the exact workflow.** Explain `docker compose --env-file container/.env -f compose.yaml -f build/container-secrets.compose.yaml -f compose.observability.yaml --profile observability config --quiet` for config validation, the same file list with `up -d --build`, `http://127.0.0.1:6006` for UI, and the same file list with `down` for stop. State that initial `container:setup --apply` remains separately operator-controlled, and that stopping the overlay does not delete the Phoenix volume. Explain how to inspect the named `openclaw.message.processed`, `openclaw.run`, `openclaw.tool.execution`, and `openclaw.message.delivery` spans, same trace ID, and no sentinel/protected content. Distinguish Current, Validated, Target, and Runtime-proven.
- [ ] **Step 3: Run focused and full gates.** Run `node --test scripts/test/observability-config.test.mjs scripts/test/container-observability.test.mjs scripts/test/collector-privacy.test.mjs scripts/test/golden-eval.test.mjs`, `npm run eval:golden`, `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, `git status --short`, and `git status --ignored --short`. Expected: all checks exit 0; ignored runtime/build artifacts remain untracked. If any fail, diagnose before claiming completion.
- [ ] **Step 4: Controlled live gate.** Only if the operator has a configured local Friday instance and approves a controlled Slack turn, start the overlay, issue a synthetic authorized read-only request, and verify the four named span classes share a trace ID in Phoenix. Inspect post-Collector data for prompts, Slack text, secrets, paths, raw identifiers, arguments, outputs, events, links, status text, and sentinel values. Record time, image digests, command, observed trace ID only in private operator notes; the repository document records pass/fail and evidence category without raw runtime state. If unavailable or failed, state `Not runtime-proven` and do not weaken privacy to make the trace appear.
- [ ] **Step 5: Final review and commit.** Run GitNexus `detect_changes` with `scope:"all"` and both `repo`/`worktree` set to the exact `git rev-parse --show-toplevel` result; stage only `docs/CONTAINER_SETUP.md` and `scripts/test/container-observability.test.mjs`; commit `docs: explain container observability gate`. Do not merge or push. Rollback: revert the Phase 1 commits and stop the overlay; keep Friday state and Phoenix data until their owners decide retention.
