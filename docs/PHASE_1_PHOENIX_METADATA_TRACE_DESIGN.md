# Phase 1 Phoenix metadata and trace continuity design

Status: design for review, 2026-09-24. This document authorizes no build,
container restart, runtime configuration change, or Phoenix data deletion.
It extends only the container observability slice in
`docs/PHASE_1_CONTAINER_OBSERVABILITY_DESIGN.md`.

## Outcome and evidence boundary

Phoenix should show bounded diagnostic metadata for a new Friday turn: the
configured model and provider, token and prompt-shape counts, an allowlisted
event name when OpenClaw emits one, and a categorical status message on error.
The content panel may remain empty: prompt text, Slack messages, assistant
text, system instructions, repository contents, tool inputs and outputs, and
raw errors are not part of this design. Span IDs and parent IDs, rather than
message text or a Slack identifier, establish trace continuity.

- **Current:** the running gateway uses the bundled diagnostics plugin in
  pinned OpenClaw `2026.7.1-2`; Collector Contrib `0.161.0` filters to six
  OpenClaw span names and exports to Phoenix `20.15.0`. All OpenClaw
  `captureContent` switches, logs, and metrics are disabled. The Collector
  drops events and status messages, strips prompt-shape counts, retains only
  `gen_ai.provider.name`, and maps all model names except `gpt-5.6-sol` to
  `other`.
- **Validated:** read-only inspection of the running pinned plugin found that
  its current semantic-convention mode emits provider under `gen_ai.system`,
  not `gen_ai.provider.name`. Its model-call span has numeric prompt-shape
  attributes. Its `openclaw.provider.request` event carries an upstream
  request-ID hash attribute. The host bundle emits `model.usage` with a child
  diagnostic trace only when `runResult.diagnosticTrace` exists; the plugin
  attaches it only when it can resolve a trusted active or retained parent.
  Recent Phoenix data contained standalone `openclaw.model.usage` roots and
  `openclaw.run` spans whose parent was omitted by the Collector filter.
- **Target:** for controlled new turns, safe metadata survives the Collector
  and the message, harness, run, model-call, usage, tool, and delivery spans
  emitted for one turn share one trace ID where the pinned runtime provides
  their trusted parent context. No synthetic trace reparenting is allowed.
- **Runtime-proven:** false until the post-change Collector output and a new
  controlled Phoenix trace satisfy the acceptance checks below. Existing
  Phoenix spans are historical evidence and are not rewritten.

The GitNexus index in this worktree names an earlier commit than current
`HEAD`; it is not evidence for current call paths. Source inspection and a
bounded runtime probe must establish the exact patch target before any vendor
bundle edit. No Hermes, Jev, or new OpenClaw interface is introduced.

## Selected approach

Use both a default-deny Collector update and, only after a diagnostic test
identifies the missing trusted parent, a hash-verified compatibility patch
against the pinned OpenClaw bundle. A Collector-only change can preserve an
already emitted parent span but cannot recover a trace ID that the gateway
never put on a usage event. Correlating spans by timestamps, model name,
token count, or Slack thread would be ambiguous and is rejected.

Keep the existing Compose profile, image pins, read-only container posture,
gateway Security Shield, read-only tools, and Jira approval path unchanged.
Do not add a dependency or a second telemetry SDK. The gateway continues to
emit to the private Collector endpoint; only the Collector sends to Phoenix.

## Collector export contract

The Collector retains its existing service-name rewrite and deny-by-default
attribute policy. It adds `openclaw.harness.run` to the named-span filter so
an exported `openclaw.run` can have its actual parent. It retains only these
additional span attributes:

- On `openclaw.model.call` only, nonnegative integer values for
  `openclaw.model_call.prompt.input_messages_count`,
  `openclaw.model_call.prompt.input_messages_chars`,
  `openclaw.model_call.prompt.system_prompt_chars`,
  `openclaw.model_call.prompt.tool_definitions_count`,
  `openclaw.model_call.prompt.tool_definitions_chars`, and
  `openclaw.model_call.prompt.total_chars`. Missing or non-integer values are
  omitted. These are size/count metadata, never text content.
- On model-call and model-usage spans only, `gen_ai.request.model` if it
  matches an explicit reviewed provider/model allowlist for this container
  profile; otherwise the value is `other`. The allowlist is updated from
  reviewed, non-secret model IDs, not by exporting arbitrary configured
  strings. A test covers every currently configured primary/fallback model
  without printing runtime configuration values.
- On model-call and model-usage spans only, `gen_ai.provider.name`, copied
  from the pinned plugin's `gen_ai.system` when the newer key is absent.
  Only `openai` and `anthropic` survive; other values become `other`.
  `gen_ai.system` itself is removed before export.

An event is exported only when its name is exactly
`openclaw.provider.request`; all event attributes, including the request-ID
hash, are deleted. Unknown event names are dropped. Successful spans keep an
empty status message. Error spans receive only a bounded category derived
from an already allowlisted `openclaw.errorCategory` or `openclaw.errorCode`;
otherwise the message is the literal `error`. The raw OpenClaw status message
is never copied. Links, trace state, unreviewed resource/scope/span keys,
and all OTLP logs remain blocked. Tests must inspect the serialized payload
*after* Collector processing, not merely the YAML.

## Pinned OpenClaw trace-continuity decision

A controlled diagnostic fixture must record only booleans and IDs needed for
correlation: whether `runResult.diagnosticTrace` exists, whether the trusted
`model.usage` event carries a parent span ID, whether that parent belongs to
the same trace, whether the plugin resolves the active/retained parent, and
whether the Collector exports that parent. It must not record prompts,
messages, tool arguments/results, credentials, raw errors, or runtime config.

The test outcome selects exactly one source-level fix:

1. If `runResult.diagnosticTrace` is absent despite an active trusted run
   trace, patch the pinned host bundle's existing result-propagation path so
   `model.usage` receives a child of that run trace. Do not create a new
   trace ID or invent an event field.
2. If the usage event has a trusted parent span ID but the diagnostics plugin
   has already discarded that parent, patch the pinned plugin's existing
   active/retained-parent lifecycle to keep that same-trace context through
   usage emission. Do not accept untrusted event trace context or widen the
   retention scope beyond the associated run.
3. If the gateway emits a valid parent and the plugin resolves it, do not
   patch OpenClaw. Retain the missing parent span in the Collector and verify
   the resulting hierarchy. A source patch with no demonstrated source defect
   would add risk without improving correlation.

Any compatibility patch follows the existing `compat/slack` discipline:
exact OpenClaw release and preimage hashes, a minimal transform, a hash of
the expected result, an idempotent check mode, focused tests for supported
and unsupported bundle bytes, and an image-build failure on mismatch. It is
applied at build time only to the pinned container image, not to the user's
original checkout or live OpenClaw state. An OpenClaw upgrade requires fresh
inspection and hashes; no fuzzy patching or silent fallback is permitted.

## Validation and cutover gates

Implementation starts with failing focused tests. Collector fixtures include
an allowed model/provider pair, each configured model, an unknown model,
`gen_ai.system` without the newer key, numeric and malformed prompt counts,
an allowed and unknown event, a request-ID-hash sentinel, a raw-status
sentinel, a filtered harness parent, and unrelated secret attributes. The
test asserts the allowed values and parent IDs survive and every sentinel is
absent from the processed export. A separate pinned-bundle test proves the
selected trace patch keeps the original trace ID and trusted parent; invalid
or untrusted context must still fail closed.

Run the focused Node tests, Collector configuration validation, Compose
configuration check, then `npm test`, `npm run typecheck`, `npm run build`,
`git diff --check`, and a diff/status review. No setup/deploy command is a
substitute for these source checks. A reviewed image build must pass the
hash-pinned compatibility check before a controlled gateway cutover.

After explicit cutover authorization, generate one new owner-controlled Slack
turn that uses the current read-only path. Inspect Phoenix by projecting only
span names, parent/trace relationships, safe attributes, event names, and
status categories. Acceptance requires: the configured model/provider are
not `other`/missing for that turn; prompt-shape metadata is numeric where
emitted; no content or sentinel leaks; no exported child points to a filtered
parent; and every span belonging to that single turn shares one trace ID.
If the pinned runtime emits a span outside the trusted turn, classify it
separately rather than falsely reparent it. If any gate fails, mark
runtime-proven false and leave the current gateway image in place.

## Rollback and ownership

Before cutover, the currently running gateway image and Collector config are
the rollback targets. Revert the opt-in Collector change and switch the
gateway back to the previous reviewed image; keep the Phoenix volume for
inspection. Do not delete or reset Friday's Security Shield, Jira, or Git
cache databases, OpenClaw state, or Phoenix data. The Collector remains the
privacy enforcement boundary even if the gateway patch is rolled back.

This change does not grant any model-facing write capability, change
authorization, approve a Jira action, or make Phoenix an audit authority.
