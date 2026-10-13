import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probeImplementation = await import("../openclaw-trace-probe.mjs").catch(() => undefined);
const baseImage = "ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac";

const modelUsageDiagnosticAnchor = [
  "\t\t\temitTrustedDiagnosticEvent({",
  '\t\t\t\ttype: "model.usage",',
  "\t\t\t\trunId,",
  "\t\t\t\t...runResult.diagnosticTrace ? { trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runResult.diagnosticTrace)) } : {},",
  "\t\t\t\tsessionKey,",
].join("\n");

const modelUsageSpanAnchor = [
  '        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {',
  "          parentContext: modelUsageParentContext(evt, metadata),",
  "          endTimeMs: evt.ts,",
  "        });",
].join("\n");

function captureProbeOutput(run) {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = function capture(chunk) {
    output += String(chunk);
    return true;
  };
  try {
    return { result: run(), output };
  } finally {
    process.stderr.write = originalWrite;
  }
}

test("trace probe target bytes match the pinned OpenClaw release", { timeout: 30000 }, () => {
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--entrypoint", "sha256sum", baseImage,
    "/app/dist/selection-JInn13lc.js",
    "/app/dist/agent-runner.runtime-DtdxZiBX.js",
    "/app/extensions/diagnostics-otel/src/service.ts",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "ccff13111aa60369ac9d88b526a58a7df1f733f1d99d205c01c6186036957e66  /app/dist/selection-JInn13lc.js",
    "37e2d3f40651107f5fa9abe76ccc9b2345497f952991dec50a2d18eaf8c35c42  /app/dist/agent-runner.runtime-DtdxZiBX.js",
    "91e602a187a0da68496d19671c8a6f55fa34a56369f0da2a239bcd8a33600c4a  /app/extensions/diagnostics-otel/src/service.ts",
  ]);
});

test("host trace probe emits only whether the model-usage result carries a trace", () => {
  assert.equal(typeof probeImplementation?.patchTraceProbe, "function");
  const before = [
    "function emitUsage(runResult, runId, emitTrustedDiagnosticEvent, freezeDiagnosticTraceContext, createChildDiagnosticTraceContext, sessionKey) {",
    modelUsageDiagnosticAnchor,
    '\t\t\t\tsessionId: "session-safe",',
    "\t\t\t});",
    "}",
  ].join("\n");
  const patched = probeImplementation.patchTraceProbe(before, "host");
  assert.equal(patched.state, "patched");
  const execute = new Function(
    `${patched.source}\nreturn emitUsage;`,
  )();

  for (const [diagnosticTrace, expected] of [
    [{ traceId: "0123456789abcdef0123456789abcdef" }, "FRIDAY_TRACE_PROBE_RESULT=present\n"],
    [undefined, "FRIDAY_TRACE_PROBE_RESULT=absent\n"],
  ]) {
    const events = [];
    const { output } = captureProbeOutput(() => execute(
      { diagnosticTrace },
      "run-safe-1",
      (event) => events.push(event),
      (trace) => trace,
      (trace) => trace,
      "session-safe",
    ));
    assert.equal(output, expected);
    assert.equal(events.length, 1);
    assert.doesNotMatch(output, /0123456789abcdef/);
  }

  assert.deepEqual(probeImplementation.patchTraceProbe(patched.source, "host"), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => probeImplementation.patchTraceProbe("unknown source", "host"), /exactly one/);
  assert.throws(() => probeImplementation.patchTraceProbe(`${before}\n${before}`, "host"), /exactly one/);
});

test("diagnostics trace probe classifies only missing, lost, or resolved trusted parents", () => {
  assert.equal(typeof probeImplementation?.patchTraceProbe, "function");
  const before = [
    "function recordUsage(evt, metadata, trustedTraceContext, modelUsageParentContext, spanWithDuration) {",
    "        const spanAttrs = {};",
    modelUsageSpanAnchor,
    "        return span;",
    "}",
  ].join("\n");
  const patched = probeImplementation.patchTraceProbe(before, "plugin");
  assert.equal(patched.state, "patched");
  const execute = new Function(`${patched.source}\nreturn recordUsage;`)();

  const cases = [
    {
      evt: { trace: { parentSpanId: "aaaaaaaaaaaaaaaa" } },
      metadata: { trusted: false },
      parent: undefined,
      status: "missing_event_trace",
    },
    {
      evt: { trace: { parentSpanId: "bbbbbbbbbbbbbbbb" } },
      metadata: { trusted: true },
      parent: undefined,
      status: "lost_trusted_parent",
    },
    {
      evt: { trace: { parentSpanId: "cccccccccccccccc" } },
      metadata: { trusted: true },
      parent: { traceId: "dddddddddddddddddddddddddddddddd", spanId: "cccccccccccccccc" },
      status: "resolved_parent",
    },
  ];

  for (const { evt, metadata, parent, status } of cases) {
    let activeParentCalls = 0;
    let receivedParent;
    const trustedTraceContext = (event, currentMetadata) => currentMetadata.trusted ? event.trace : undefined;
    const modelUsageParentContext = () => {
      activeParentCalls += 1;
      return parent;
    };
    const spanWithDuration = (_name, _attrs, _duration, options) => {
      receivedParent = options.parentContext;
      return { end() {} };
    };
    const { output } = captureProbeOutput(() => execute(
      evt,
      metadata,
      trustedTraceContext,
      modelUsageParentContext,
      spanWithDuration,
    ));
    assert.equal(output, `FRIDAY_TRACE_PROBE_PARENT=${status}\n`);
    assert.equal(activeParentCalls, 1);
    assert.equal(receivedParent, parent);
    assert.doesNotMatch(output, /aaaaaaaa|bbbbbbbb|cccccccc|dddddddd/);
  }

  assert.deepEqual(probeImplementation.patchTraceProbe(patched.source, "plugin"), {
    source: patched.source,
    state: "already-patched",
  });
  assert.throws(() => probeImplementation.patchTraceProbe("unknown source", "plugin"), /exactly one/);
  assert.throws(() => probeImplementation.patchTraceProbe(`${before}\n${before}`, "plugin"), /exactly one/);
});
