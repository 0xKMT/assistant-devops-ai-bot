import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const implementation = await import("../openclaw-trace-fix.mjs").catch(() => undefined);
const diagnosticsImplementation = await import("../openclaw-diagnostics-usage-fix.mjs").catch(() => undefined);
const ingressImplementation = await import("../openclaw-ingress-trace-fix.mjs").catch(() => undefined);
const runnerImplementation = await import("../openclaw-runner-usage-trace-fix.mjs").catch(() => undefined);
const baseImage = "ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac";

test("pinned OpenClaw selection source retains its reviewed preimage hash", { timeout: 30000 }, () => {
  const result = spawnSync("docker", [
    "run", "--rm", "--entrypoint", "sha256sum", baseImage,
    "/app/dist/selection-JInn13lc.js",
    "/app/extensions/diagnostics-otel/src/service.ts",
    "/app/dist/agent-command-ABV9I5el.js",
    "/app/dist/agent-runner.runtime-DtdxZiBX.js",
    "/app/dist/agent-tools.before-tool-call-C95DXQXZ.js",
    "/app/dist/tool-result-error-Bz7hBpM1.js",
    "/app/dist/attempt.model-diagnostic-events-CfZQM0hs.js",
    "/app/dist/diagnostic-error-metadata-yrw7ASmg.js",
    "/app/extensions/diagnostics-otel/api.ts",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "ccff13111aa60369ac9d88b526a58a7df1f733f1d99d205c01c6186036957e66  /app/dist/selection-JInn13lc.js",
    "91e602a187a0da68496d19671c8a6f55fa34a56369f0da2a239bcd8a33600c4a  /app/extensions/diagnostics-otel/src/service.ts",
    "e44528f0fa46bd3e5e0e4be6c279a1a499f1b5c224fe760cf67dec4e2b641aee  /app/dist/agent-command-ABV9I5el.js",
    "37e2d3f40651107f5fa9abe76ccc9b2345497f952991dec50a2d18eaf8c35c42  /app/dist/agent-runner.runtime-DtdxZiBX.js",
    "02e0b2199ad0ccdea06f7a7516642ca9b6265e8d05a2859816cd3497adb2c7c1  /app/dist/agent-tools.before-tool-call-C95DXQXZ.js",
    "18f223c9c45d060bda113e66bbef50e98123e9df91dc37660a79b3907fcb83b4  /app/dist/tool-result-error-Bz7hBpM1.js",
    "93dee4bce1f7df5fc695598457c07301e863e5cff67952a0aeda72cef875b2a1  /app/dist/attempt.model-diagnostic-events-CfZQM0hs.js",
    "3f0bf1fa5248ff13b5ec93eb03dde7c8973ceac5042287e0f504f9ff8ea3081e  /app/dist/diagnostic-error-metadata-yrw7ASmg.js",
    "68464089ba6c6c82a44de4f675fafa2b35d791201895d7b79b28611cd40f5571  /app/extensions/diagnostics-otel/api.ts",
  ]);
});

test("pinned OpenClaw run results return the span context emitted by run.started", () => {
  assert.equal(typeof implementation?.patchOpenClawTraceContext, "function");
  const before = [
    "\t\t\t\tsessionFileUsed,",
    "\t\t\t\tdiagnosticTrace,",
    "\t\t\t\tbootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,",
  ].join("\n");
  const patched = implementation.patchOpenClawTraceContext(before);
  assert.equal(patched.state, "patched");
  assert.equal(patched.source, before.replace("diagnosticTrace,", "diagnosticTrace: runTrace,"));
  assert.deepEqual(implementation.patchOpenClawTraceContext(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => implementation.patchOpenClawTraceContext("unreviewed vendor bytes"), /exactly one/);
  assert.throws(() => implementation.patchOpenClawTraceContext(`${before}\n${before}`), /exactly one/);
});

test("model usage preserves a trusted parent when its lifecycle span is no longer active", () => {
  assert.equal(typeof diagnosticsImplementation?.patchOpenClawDiagnosticsUsageContext, "function");
  const before = [
    "      const retainedTrustedSpanContexts = new Map<",
    "        string,",
    "        { spanContext: SpanContext; token: symbol; owner?: TrustedSpanAliasOwner }",
    "      >();",
    "        retainedTrustedSpanContexts.clear();",
    "        const parentSpanId = trustedTraceContext(evt, metadata)?.parentSpanId;",
    "        assignModelCallPromptStatsAttrs(spanAttrs, evt);",
    "        trackTrustedSpan(",
    "      const recordModelUsage = (",
    '        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {',
    "          parentContext: activeTrustedParentContext(evt, metadata),",
  ].join("\n");
  const patched = diagnosticsImplementation.patchOpenClawDiagnosticsUsageContext(before);
  assert.equal(patched.state, "patched");
  assert.match(patched.source, /parentContext: modelUsageParentContext\(evt, metadata\)/);
  assert.match(patched.source, /trustedRunSpanContexts\.set\(evt\.runId/);
  assert.match(patched.source, /openclaw\.channel.*runContext\.channel/);
  assert.match(patched.source, /trustedRunSpanContexts\.clear\(\)/);
  assert.deepEqual(diagnosticsImplementation.patchOpenClawDiagnosticsUsageContext(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => diagnosticsImplementation.patchOpenClawDiagnosticsUsageContext("unreviewed plugin bytes"), /exactly one/);
  assert.throws(() => diagnosticsImplementation.patchOpenClawDiagnosticsUsageContext(`${before}\n${before}`), /exactly one/);
});

test("pinned tool-result diagnostics retain only the fixed docs category, code, and numeric HTTP status", () => {
  assert.equal(typeof diagnosticsImplementation?.patchOpenClawToolResultFailure, "function");
  assert.equal(typeof diagnosticsImplementation?.docsFailureMetadataHelpers, "string");
  const resolveFailure = new Function(
    `${diagnosticsImplementation.docsFailureMetadataHelpers}\nreturn fridayDocsFailureMetadata;`,
  )();
  const cases = [
    {
      details: { ok: false, category: "timeout", errorCode: "DOCS_TIMEOUT" },
      expected: { category: "timeout", errorCode: "DOCS_TIMEOUT" },
    },
    {
      details: { ok: false, category: "not_found", errorCode: "DOCS_NOT_FOUND", httpStatus: 404 },
      expected: { category: "not_found", errorCode: "DOCS_NOT_FOUND", httpStatus: 404 },
    },
    {
      details: { ok: false, category: "network", errorCode: "DOCS_NETWORK" },
      expected: { category: "network", errorCode: "DOCS_NETWORK" },
    },
    {
      details: { ok: false, category: "rate_limit", errorCode: "DOCS_RATE_LIMITED", httpStatus: 429 },
      expected: { category: "rate_limit", errorCode: "DOCS_RATE_LIMITED", httpStatus: 429 },
    },
    {
      details: {
        ok: false,
        category: "not_found",
        errorCode: "DOCS_NOT_FOUND",
        httpStatus: 700,
        errorMessage: "FRIDAY_SENTINEL_RAW_ERROR",
      },
      expected: { category: "not_found", errorCode: "DOCS_NOT_FOUND" },
    },
    {
      details: { ok: false, category: "unreviewed-category", errorCode: "DOCS_UNKNOWN" },
      expected: { category: "other", errorCode: "other" },
    },
    {
      details: { ok: true, category: "not_found", errorCode: "DOCS_NOT_FOUND", httpStatus: 404 },
      expected: undefined,
    },
  ];

  for (const { details, expected } of cases) {
    const actual = resolveFailure(details);
    assert.deepEqual(actual, expected);
    if (actual !== undefined) assert.doesNotMatch(JSON.stringify(actual), /FRIDAY_SENTINEL_/);
  }
});

test("pinned tool-result patch fails closed on wrong, duplicate, and partial source anchors", () => {
  assert.equal(typeof diagnosticsImplementation?.patchOpenClawToolResultFailure, "function");
  const before = [
    "function resolveToolResultTerminalDiagnostic(result, durationMs) {",
    "\tconst failureKind = resolveToolResultFailureKind(result);",
    "\tif (!failureKind) return { type: \"tool.execution.completed\", durationMs };",
    "\tif (failureKind === \"blocked\") return { type: \"tool.execution.blocked\" };",
    "\treturn {",
    "\t\ttype: \"tool.execution.error\",",
    "\t\tdurationMs,",
    "\t\terrorCategory: \"tool_result_error\",",
    "\t\tterminalReason: failureKind",
    "\t};",
    "}",
  ].join("\n");
  const patched = diagnosticsImplementation.patchOpenClawToolResultFailure(before);
  assert.equal(patched.state, "patched");
  assert.match(patched.source, /fridayDocsFailureMetadata/);
  assert.match(patched.source, /errorCategory: docsFailure\?\.category/);
  assert.deepEqual(diagnosticsImplementation.patchOpenClawToolResultFailure(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => diagnosticsImplementation.patchOpenClawToolResultFailure("unreviewed vendor bytes"), /exactly one/);
  assert.throws(() => diagnosticsImplementation.patchOpenClawToolResultFailure(`${before}\n${before}`), /exactly one/);
  assert.throws(() => diagnosticsImplementation.patchOpenClawToolResultFailure(before.replace("tool_result_error", "partial")), /exactly one/);
});

test("pinned model failures are logged locally without adding raw error data to the event fields", () => {
  assert.equal(typeof diagnosticsImplementation?.patchOpenClawModelErrorLogging, "function");
  const before = [
    "function modelCallErrorFields(err) {",
    "\tconst upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);",
    "\tconst failureKind = diagnosticErrorFailureKind(err);",
    "\treturn {",
    "\t\terrorCategory: diagnosticErrorCategory(err),",
    "\t\t...failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {},",
    "\t\t...upstreamRequestIdHash ? { upstreamRequestIdHash } : {}",
    "\t};",
    "}",
  ].join("\n");
  const patched = diagnosticsImplementation.patchOpenClawModelErrorLogging(before);
  assert.equal(patched.state, "patched");
  assert.match(patched.source, /operation: "model_call"/);
  assert.match(
    patched.source,
    /^import \{ appendLocalErrorRecord \} from "\/opt\/friday\/source\/integrations\/openai-docs-adapter\/dist\/local-error-log\.js";$/m,
  );
  assert.match(patched.source, /appendLocalErrorRecord/);
  assert.match(patched.source, /void appendLocalErrorRecord\(record\)/);
  assert.doesNotMatch(patched.source, /void import\(/);
  assert.match(patched.source, /statusCode/);
  assert.match(patched.source, /errorStack/);
  const eventFields = patched.source.slice(patched.source.indexOf("\treturn {"));
  assert.match(eventFields, /errorCategory: diagnosticErrorCategory\(err\)/);
  assert.doesNotMatch(eventFields, /FRIDAY_SENTINEL|errorMessage:|errorStack:/);
  const syntaxCheck = spawnSync("node", ["--check", "--input-type=module"], {
    input: patched.source,
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
  assert.deepEqual(diagnosticsImplementation.patchOpenClawModelErrorLogging(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => diagnosticsImplementation.patchOpenClawModelErrorLogging("unreviewed vendor bytes"), /exactly one/);
  assert.throws(() => diagnosticsImplementation.patchOpenClawModelErrorLogging(`${before}\n${before}`), /exactly one/);
  assert.throws(() => diagnosticsImplementation.patchOpenClawModelErrorLogging(before.replace("failureKind", "partial")), /exactly one/);
});

test("pinned failure-category and status transform uses only bounded existing fields", () => {
  assert.equal(typeof diagnosticsImplementation?.patchOpenClawDiagnosticsFailureMetadata, "function");
  assert.equal(typeof diagnosticsImplementation?.serviceFailureMetadataHelpers, "string");
  const helpers = diagnosticsImplementation.serviceFailureMetadataHelpers
    .replaceAll(": Readonly<Record<string, string>>", "")
    .replaceAll(": unknown", "")
    .replaceAll(": string =>", " =>");
  const behavior = new Function(`${helpers}\nreturn { fridayModelCallErrorCategory, fridayToolErrorMetadata };`)();
  assert.equal(behavior.fridayModelCallErrorCategory("Error", "timeout"), "timeout");
  assert.equal(behavior.fridayModelCallErrorCategory("Error", "connection_reset"), "network");
  assert.equal(behavior.fridayModelCallErrorCategory("Error", "unreviewed"), "other");
  assert.deepEqual(behavior.fridayToolErrorMetadata("not_found", "404"), {
    category: "not_found",
    code: "DOCS_NOT_FOUND",
    httpStatus: 404,
  });
  assert.deepEqual(behavior.fridayToolErrorMetadata("network", "DOCS_NETWORK"), {
    category: "network",
    code: "DOCS_NETWORK",
  });
  assert.deepEqual(behavior.fridayToolErrorMetadata("unreviewed", "FRIDAY_SENTINEL_CODE"), {
    category: "other",
    code: "other",
  });

  const before = [
    "      const recordModelCallError = (",
    '        evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,',
    "        metadata: DiagnosticEventMetadata,",
    "        modelContent?: OtelModelCallContent,",
    "      ) => {",
    '        const errorType = lowCardinalityAttr(evt.errorCategory, "other");',
    "      const recordToolExecutionError = (",
    "        const attrs = {",
    "          ...toolExecutionBaseAttrs(evt),",
    '          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),',
    "        };",
    "        if (evt.errorCode) {",
    '          spanAttrs["openclaw.errorCode"] = lowCardinalityAttr(evt.errorCode, "other");',
    "        }",
  ].join("\n");
  const patched = diagnosticsImplementation.patchOpenClawDiagnosticsFailureMetadata(before);
  assert.equal(patched.state, "patched");
  assert.match(patched.source, /fridayModelCallErrorCategory\(evt\.errorCategory, evt\.failureKind\)/);
  assert.match(patched.source, /http\.response\.status_code.*failureMetadata\.httpStatus/);
  assert.match(patched.source, /fridayDocsErrorCodes\[safeCategory\]/);
  assert.deepEqual(diagnosticsImplementation.patchOpenClawDiagnosticsFailureMetadata(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => diagnosticsImplementation.patchOpenClawDiagnosticsFailureMetadata("unknown bytes"), /exactly one/);
});

test("pinned ingress usage keeps the completed run context through delivery and emission", () => {
  assert.equal(typeof ingressImplementation?.patchOpenClawIngressUsageTrace, "function");
  const before = [
    "function finishAgentCommand(result, deliveryResult) {",
    "  return deliveryResult;",
    "}",
    "function emitIngressModelUsageDiagnostic(result, opts) {",
    "  emitTrustedDiagnosticEvent({",
    '    type: "model.usage",',
    '    sessionKey: "friday-session",',
    "  });",
    "}",
  ].join("\n");
  const patched = ingressImplementation.patchOpenClawIngressUsageTrace(before);
  assert.equal(patched.state, "patched");

  const events = [];
  const run = new Function(
    "emitTrustedDiagnosticEvent",
    `${patched.source}\nreturn { finishAgentCommand, emitIngressModelUsageDiagnostic };`,
  );
  const behavior = run((event) => events.push(event));
  const trace = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: "abcdef0123456789",
    traceFlags: "01",
  };
  const delivered = behavior.finishAgentCommand(
    { diagnosticTrace: trace },
    { meta: { agentMeta: { provider: "openai" } } },
  );
  behavior.emitIngressModelUsageDiagnostic(delivered, { runId: "run-safe-1" });

  assert.deepEqual(events, [{
    type: "model.usage",
    runId: "run-safe-1",
    trace,
    sessionKey: "friday-session",
  }]);
  assert.equal(delivered.meta.agentMeta.provider, "openai");

  events.length = 0;
  behavior.emitIngressModelUsageDiagnostic(delivered, {});
  assert.deepEqual(events, [{
    type: "model.usage",
    trace,
    sessionKey: "friday-session",
  }]);
  assert.deepEqual(ingressImplementation.patchOpenClawIngressUsageTrace(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => ingressImplementation.patchOpenClawIngressUsageTrace("unreviewed vendor bytes"), /exactly one/);
  assert.throws(() => ingressImplementation.patchOpenClawIngressUsageTrace(`${before}\n${before}`), /exactly one/);
});

test("Slack runner model-usage events carry their run ID for trusted trace correlation", () => {
  assert.equal(typeof runnerImplementation?.patchOpenClawRunnerUsageTrace, "function");
  const before = [
    "emitTrustedDiagnosticEvent({",
    '  type: "model.usage",',
    "  sessionKey,",
    "});",
  ].join("\n");
  const patched = runnerImplementation.patchOpenClawRunnerUsageTrace(before);
  assert.equal(patched.state, "patched");
  assert.equal(patched.source, before.replace('  type: "model.usage",', '  type: "model.usage",\n  runId,'));
  assert.deepEqual(runnerImplementation.patchOpenClawRunnerUsageTrace(patched.source), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => runnerImplementation.patchOpenClawRunnerUsageTrace("unreviewed vendor bytes"), /exactly one/);
  assert.throws(() => runnerImplementation.patchOpenClawRunnerUsageTrace(`${before}\n${before}`), /exactly one/);
});

test("trusted run context supplies model-call channel and late usage parent without trusting untrusted events", () => {
  assert.equal(typeof diagnosticsImplementation?.runContextHelpers, "string");
  const trace = {
    setSpanContext: (_context, spanContext) => ({ spanContext: () => spanContext }),
  };
  const runtime = new Function(
    "trace",
    "otelContextApi",
    "activeInternalOrTrustedContext",
    "lowCardinalityAttr",
    `const trustedRunSpanContexts = new Map();\n${diagnosticsImplementation.runContextHelpers
      .replaceAll(": DiagnosticEventPayload & { runId?: unknown; channel?: unknown }", "")
      .replaceAll(": DiagnosticEventMetadata", "")
      .replaceAll(": ReturnType<typeof tracer.startSpan>", "")
      .replaceAll(": any", "")}\nreturn { rememberTrustedRunSpanContext, trustedRunSpanContext, modelUsageParentContext, trustedRunSpanContexts };`,
  )(
    trace,
    { active: () => ({ active: true }) },
    (event) => event.traceContext,
    (value) => value,
  );
  const runSpanContext = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    traceFlags: 1,
  };
  runtime.rememberTrustedRunSpanContext(
    { runId: "run-safe-1", channel: "slack" },
    { trusted: true },
    { spanContext: () => runSpanContext },
  );

  assert.equal(runtime.trustedRunSpanContext({ runId: "run-safe-1" }, { trusted: true }).channel, "slack");
  assert.deepEqual(
    runtime.modelUsageParentContext({ runId: "run-safe-1" }, { trusted: true }).spanContext(),
    runSpanContext,
  );
  assert.equal(runtime.trustedRunSpanContexts.has("run-safe-1"), false);

  runtime.rememberTrustedRunSpanContext(
    { runId: "run-safe-2", channel: "slack" },
    { trusted: true },
    { spanContext: () => runSpanContext },
  );
  assert.equal(runtime.trustedRunSpanContext({ runId: "run-safe-2" }, { trusted: false }), undefined);
  assert.equal(runtime.modelUsageParentContext({ runId: "run-safe-2" }, { trusted: false }), undefined);
  assert.equal(runtime.trustedRunSpanContexts.has("run-safe-2"), true);

  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    runtime.rememberTrustedRunSpanContext(
      { runId: "run-expiring", channel: "slack" },
      { trusted: true },
      { spanContext: () => runSpanContext },
    );
    now += 60_001;
    assert.equal(runtime.trustedRunSpanContext({ runId: "run-expiring" }, { trusted: true }), undefined);
    assert.equal(runtime.trustedRunSpanContexts.has("run-expiring"), false);
    now += 60_001;
    for (let index = 0; index < 513; index += 1) {
      runtime.rememberTrustedRunSpanContext(
        { runId: `run-bounded-${index}`, channel: "slack" },
        { trusted: true },
        { spanContext: () => runSpanContext },
      );
    }
    assert.equal(runtime.trustedRunSpanContexts.size, 512);
    assert.equal(runtime.trustedRunSpanContexts.has("run-bounded-0"), false);
  } finally {
    Date.now = originalNow;
  }
});
