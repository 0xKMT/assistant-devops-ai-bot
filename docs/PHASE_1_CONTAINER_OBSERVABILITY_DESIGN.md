# Phase 1 Container Observability Design

Status: proposed implementation design for review. Scope: the Friday container
profile only. This document does not assert that observability is deployed or
runtime-proven.

## Evidence and decision boundary

- **Current:** `compose.yaml` runs the Friday gateway and an optional CLI; it has
  no Collector or Phoenix service. `scripts/prepare-instance.mjs` generates the
  OpenClaw configuration and explicitly allowlists the existing plugins.
- **Validated:** source inspection at the current checkout found the pinned
  OpenClaw `2026.7.1-2` documentation for its official `diagnostics-otel`
  plugin, OTLP/HTTP protobuf export, content-capture controls, and named
  message/model/tool spans. `docs/OPENCLAW_COMPATIBILITY_SPIKE.md` validated
  declared lifecycle and usage shapes, not a configured Friday trace.
- **Target:** one containerized Slack request, authorized tool execution, and
  response can be followed in Phoenix through a single trace, with no protected
  content; a small synthetic golden evaluation runs reproducibly.
- **Runtime-proven:** remains false until a controlled Friday run produces and
  passes the trace and privacy checks below. Vendor declarations and a passing
  unit test do not promote this state.

This is Phase 1 of `docs/LOCAL_DEVOPS_ASSISTANT_DESIGN.md`, Section 12. It does
not implement Phase 2 learning state or memory, native/macOS observability,
Hermes, Jev, Obsidian integration, a model-routing change, or any new
model-facing capability.

## Container topology

The gateway uses the pinned OpenClaw `diagnostics-otel` plugin to send traces
over OTLP/HTTP protobuf to a Collector on the private Compose network. The
Collector applies a default-deny metadata policy and exports to Phoenix's
container-internal OTLP/HTTP trace endpoint. Phoenix alone exposes its UI on a
loopback host port and owns a separate persistent named volume. The Collector
and its receiver have no published host port. The existing Friday state
volume and the three current Friday SQLite databases remain untouched.

Pin the OpenClaw diagnostics plugin to a version compatible with the already
pinned OpenClaw image; verify its install and runtime API in the container
build before enabling it. Pin the Collector Contrib and Phoenix images to
reviewed immutable digests in the implementation. Do not use floating tags.
The proposed version candidates are Collector Contrib `0.161.0` and Phoenix
`version-20.15.0-nonroot`; neither is accepted as compatible until a build and
controlled local run pass. The implementation plan must record the resolved
digests and exact verification commands.

Make observability opt-in through a separate Compose overlay and an explicit
observability profile. The overlay adds Collector/Phoenix and the gateway's
diagnostics configuration; plain `compose.yaml` retains its present behavior.
The gateway path must retain its present Security Shield, Git Adapter, Jira
Adapter, Slack allowlist, read-only repository mounts, secrets handling, and
approval workflow. The overlay must not change model-facing tools, enable
arbitrary writes, or weaken authorization. If the Collector is unavailable,
Friday's existing security decision remains authoritative; the deployment
must report telemetry failure without logging protected content. A green
telemetry test is never an authorization test.

## Trace contract and privacy

Configure the official plugin with diagnostics and OTLP enabled, protocol
`http/protobuf`, traces enabled, logs disabled, and every content-capture
switch explicitly false. Metrics remain disabled for this first trace-focused
slice; token/cost telemetry is neither required nor asserted. Do not add a
second OpenTelemetry SDK or construct an invented OpenClaw hook interface.

The Collector's trace pipeline must keep only reviewed span/resource/event
metadata keys. Candidate safe keys are service name, channel kind, operation
name, bounded tool name, outcome, duration, and bounded error category. Trace
and span IDs provide correlation; raw Slack account, workspace, channel,
thread, session, requester, tool-call, provider-request, and Jira issue IDs
must not be exported as attributes. Drop all unrecognized keys, event bodies,
links, and status messages unless a test proves they are safe and a specific
key is added to the allowlist. Suppress logs at the gateway and Collector
pipeline. Never export prompts, Slack messages, assistant text, credentials,
repository contents, tool arguments or outputs, raw runtime state, or local
paths. Tests must inspect a serialized OTLP payload after Collector processing,
not just generated configuration.

The initial trace uses OpenClaw's documented `openclaw.message.processed`,
`openclaw.run`, `openclaw.tool.execution`, and
`openclaw.message.delivery` spans. The controlled run must establish whether
these spans share one trace ID in the pinned container. Do not infer parentage
from a UI timeline or synthesize a raw Slack thread identifier. If the official
spans do not establish the required correlation, the exit gate fails; a
separate Friday span or correlation field can be designed only after the exact
runtime gap and supported API are documented.

Security Shield's authorization and Jira's approval state remain in their
existing audit/workflow stores. Phase 1 may add safe enum-only spans for those
events only after source impact analysis and a pinned-runtime correlation
probe demonstrate the supported hook/context. Their absence must be recorded
as a trace-coverage limitation, not represented as observed authorization.
Phoenix is a diagnostic/evaluation store, not an authorization or audit
authority.

## Golden evaluation

Track a small, versioned JSONL dataset of synthetic, non-secret scenarios
covering: authorized read-only review, denied requester, tool failure with a
bounded error, and Jira approval not yet granted. Each case has a stable ID,
dataset version, input fixture, expected safe outcome, and explicit evaluator
assertions. A deterministic local runner reads the tracked dataset and emits
bounded pass/fail results keyed by dataset version; it must not call Slack,
Jira, a model provider, or production infrastructure. Keep test fixtures
separate from Phoenix's mutable experiment state. A future live/model eval is
not implied by this deterministic baseline.

## Acceptance and rollback

Implementation acceptance requires focused test-first checks for generated
container configuration and privacy filtering; Collector configuration
validation; Compose profile validation; the repository `npm test`,
`npm run typecheck`, and `npm run build` gates; a reproducible golden-eval run;
and a controlled Slack-to-tool-to-response run whose same-trace span set and
post-Collector attributes are inspected in Phoenix. A synthetic sentinel for
message, prompt, token, path, and tool content must be absent from the exported
payload and Phoenix view. If the live run is unavailable, report source and
local validation only and leave runtime-proven false.

Rollback disables the opt-in profile and reverts only its configuration,
plugin, Collector, Phoenix, and evaluation files. It must not remove or reset
`friday-security.sqlite`, `friday-jira.sqlite`, `friday-cache.sqlite`, or the
Friday home volume. Preserve the Phoenix volume for review unless its owner
explicitly approves deletion. Rollback never changes Security Shield or
requester-approval policy.

## Source references

- `docs/LOCAL_DEVOPS_ASSISTANT_DESIGN.md`, Sections 5.6 and 12.
- `docs/OPENCLAW_COMPATIBILITY_SPIKE.md`, Phase 1 input and security boundary.
- Pinned OpenClaw installation's `docs/gateway/opentelemetry.md` (read-only
  compatibility evidence, not a repository runtime dependency).
- [Collector redaction processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)
  and [transform processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/transformprocessor/README.md).
- [Phoenix Docker deployment](https://arize.com/docs/phoenix/self-hosting/deployment-options/docker)
  and [Phoenix configuration](https://arize.com/docs/phoenix/self-hosting/configuration).
