# OpenClaw lifecycle and model-usage compatibility spike

## Scope and state labels

This Phase 0 spike is a read-only inspection of the TypeScript declarations
installed beside the pinned OpenClaw executable. It adds no production
telemetry, runtime configuration, dependency, event contract, or Security
Shield change.

- **Current:** a fact present in the inspected OpenClaw package declarations.
- **Validated:** a fact reproduced by the commands in this document against
  OpenClaw `2026.7.1-2`.
- **Target:** a possible Phase 1 input that remains subject to a controlled
  runtime probe and review.
- **Not runtime-proven:** a declaration exists, but actual event emission or
  semantic accuracy has not been observed.

## Pinned compatibility result

The expected and inspected OpenClaw version was exactly `2026.7.1-2`. The
probe returned `validated-declarations` and exit code zero. Its output is
bounded to the package version, evidence class, hook names, declared field
names, and conclusions. It does not include installation paths, prompt or
message values, token values, credentials, configuration, logs, or session
state.

These commands produced the validated result:

```bash
node --test scripts/test/openclaw-observability-probe.test.mjs
node scripts/probe-openclaw-observability.mjs --json > /tmp/friday-openclaw-probe.json
node -e '
  const r = require("/tmp/friday-openclaw-probe.json");
  if (r.version !== "2026.7.1-2") process.exit(1);
  if (r.evidence !== "validated-declarations") process.exit(1);
  if (!r.hooks.agent_end.declared || !r.hooks.llm_output.declared) process.exit(1);
'
rm /tmp/friday-openclaw-probe.json
```

The exact temporary report is deleted after its assertions. The installed
OpenClaw package is not installed, upgraded, patched, configured, or executed
by the declaration inspector.

## Lifecycle declarations

All rows below are **Current** and **Validated** at declaration level for
OpenClaw `2026.7.1-2`, and **Not runtime-proven**.

| Hook or context | Declared fields |
| --- | --- |
| `agent_context` | `agentId`, `channel`, `channelContext`, `channelId`, `chatId`, `contextTokenBudget`, `contextWindowReferenceTokens`, `contextWindowSource`, `jobId`, `messageProvider`, `modelId`, `modelProviderId`, `runId`, `senderExternalId`, `senderId`, `sessionId`, `sessionKey`, `trace`, `trigger`, `workspaceDir` |
| `agent_end` | `durationMs`, `error`, `messages`, `runId`, `success` |
| `model_call_started` | `api`, `callId`, `contextTokenBudget`, `contextWindowReferenceTokens`, `contextWindowSource`, `model`, `provider`, `runId`, `sessionId`, `sessionKey`, `transport` |
| `model_call_ended` | `api`, `callId`, `contextTokenBudget`, `contextWindowReferenceTokens`, `contextWindowSource`, `durationMs`, `errorCategory`, `failureKind`, `model`, `outcome`, `provider`, `requestPayloadBytes`, `responseStreamBytes`, `runId`, `sessionId`, `sessionKey`, `timeToFirstByteMs`, `transport`, `upstreamRequestIdHash` |
| `llm_input` | `historyMessages`, `imagesCount`, `model`, `prompt`, `provider`, `runId`, `sessionId`, `systemPrompt`, `tools` |
| `llm_output` | `assistantTexts`, `contextTokenBudget`, `contextWindowReferenceTokens`, `contextWindowSource`, `fastMode`, `harnessId`, `lastAssistant`, `model`, `prompt`, `provider`, `reasoningEffort`, `resolvedRef`, `runId`, `sessionId`, `usage` |

The declaration surface includes content-bearing fields such as `prompt`,
`messages`, and `assistantTexts`. Their existence is evidence only; Friday must
not collect or persist their values by default.

## Usage and cost conclusions

`llm_output.usage` declares `input`, `output`, `cacheRead`, `cacheWrite`, and
`total`. This makes token counters **Validated at declaration level only**.
They are not declared on `agent_end`.

No `cost` or `costUsd` field is declared by the inspected hook types, so
hook-level monetary cost is **Unavailable**. Phase 0 does not infer money from
token counts or invent a cost event shape.

## Evidence limits

The following remain **Not runtime-proven**:

- whether each lifecycle event is emitted for a real model turn;
- whether retries create one event or multiple events and how usage aggregates;
- whether provider token counters are complete and accurate;
- whether identifiers consistently correlate started, ended, input, output,
  and agent-end events;
- whether monetary cost is available from another authoritative runtime
  source.

The synthetic tests prove deterministic parsing, version mismatch handling,
missing-declaration handling, and explicit unavailable conclusions. They do not
simulate OpenClaw execution or provider behavior.

## Phase 1 input and security boundary

The bounded Phase 1 input is: instrument no field until a redacted controlled
turn proves the emitted event shape and correlation behavior for the pinned
runtime. Any later telemetry design must retain Security Shield, read-only and
approval boundaries, and default-deny content capture. Prompt text, message
content, assistant text, credentials, and raw runtime payloads must not be
recorded by default.

This spike does not define a Friday production interface. The vendor
declarations remain external evidence, and `types/openclaw-plugin-sdk.d.ts` is
unchanged.

## Rollback

Revert the Phase 0 spike commit to remove the inspector, tests, and this
report. No OpenClaw package, runtime state, database, configuration, or
external system requires restoration.
