import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const upstreamPath = "/app/extensions/diagnostics-otel/src/service.ts";
const upstreamSha256 = "91e602a187a0da68496d19671c8a6f55fa34a56369f0da2a239bcd8a33600c4a";
const toolResultUpstreamPath = "/app/dist/agent-tools.before-tool-call-C95DXQXZ.js";
const toolResultUpstreamSha256 = "02e0b2199ad0ccdea06f7a7516642ca9b6265e8d05a2859816cd3497adb2c7c1";
const modelErrorUpstreamPath = "/app/dist/attempt.model-diagnostic-events-CfZQM0hs.js";
const modelErrorUpstreamSha256 = "93dee4bce1f7df5fc695598457c07301e863e5cff67952a0aeda72cef875b2a1";
const diagnosticErrorMetadataPath = "/app/dist/diagnostic-error-metadata-yrw7ASmg.js";
const diagnosticErrorMetadataSha256 = "3f0bf1fa5248ff13b5ec93eb03dde7c8973ceac5042287e0f504f9ff8ea3081e";
const originalAnchor = [
  '        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {',
  "          parentContext: activeTrustedParentContext(evt, metadata),",
].join("\n");
const patchedAnchor = originalAnchor.replace(
  "activeTrustedParentContext(evt, metadata)",
  "modelUsageParentContext(evt, metadata)",
);
const trustedRunSpanContextsAnchor = "      const retainedTrustedSpanContexts = new Map<";
const trustedRunSpanContextsDeclaration = "      const trustedRunSpanContexts = new Map<\n        string,\n        { spanContext: SpanContext; channel?: string; storedAt: number }\n      >();\n";
const stopContextsAnchor = "        retainedTrustedSpanContexts.clear();";
const stopContextsPatched = `${stopContextsAnchor}\n        trustedRunSpanContexts.clear();`;
const runStartedAnchor = "        const parentSpanId = trustedTraceContext(evt, metadata)?.parentSpanId;";
const runStartedPatched = `${runStartedAnchor}\n        rememberTrustedRunSpanContext(evt, metadata, span);`;
const modelCallStartAnchor = [
  "        assignModelCallPromptStatsAttrs(spanAttrs, evt);",
  "        trackTrustedSpan(",
].join("\n");
const modelCallStartPatched = [
  "        assignModelCallPromptStatsAttrs(spanAttrs, evt);",
  "        const runContext = trustedRunSpanContext(evt, metadata);",
  '        if (runContext?.channel) spanAttrs["openclaw.channel"] = runContext.channel;',
  "        trackTrustedSpan(",
].join("\n");
const usageContextHelpers = `      const trustedRunSpanContext = (
        evt: DiagnosticEventPayload & { runId?: unknown; channel?: unknown },
        metadata: DiagnosticEventMetadata,
      ) => {
        if (!metadata.trusted && !metadata.internal) {
          return undefined;
        }
        const runId = "runId" in evt && typeof evt.runId === "string" ? evt.runId : undefined;
        if (!runId) {
          return undefined;
        }
        const retained = trustedRunSpanContexts.get(runId);
        if (!retained) {
          return undefined;
        }
        if (Date.now() - retained.storedAt > 60_000) {
          trustedRunSpanContexts.delete(runId);
          return undefined;
        }
        return retained;
      };
      const rememberTrustedRunSpanContext = (
        evt: DiagnosticEventPayload & { runId?: unknown; channel?: unknown },
        metadata: DiagnosticEventMetadata,
        span: ReturnType<typeof tracer.startSpan>,
      ) => {
        if (!metadata.trusted || typeof evt.runId !== "string" || !evt.runId) {
          return;
        }
        const now = Date.now();
        for (const [runId, retained] of trustedRunSpanContexts) {
          if (now - retained.storedAt > 60_000) {
            trustedRunSpanContexts.delete(runId);
          }
        }
        while (trustedRunSpanContexts.size >= 512 && !trustedRunSpanContexts.has(evt.runId)) {
          const oldestRunId = trustedRunSpanContexts.keys().next().value;
          if (!oldestRunId) {
            break;
          }
          trustedRunSpanContexts.delete(oldestRunId);
        }
        trustedRunSpanContexts.set(evt.runId, {
          spanContext: span.spanContext(),
          ...(typeof evt.channel === "string" ? { channel: lowCardinalityAttr(evt.channel) } : {}),
          storedAt: now,
        });
      };
      const modelUsageParentContext = (
        evt: DiagnosticEventPayload & { runId?: unknown; channel?: unknown },
        metadata: DiagnosticEventMetadata,
      ) => {
        const runContext = trustedRunSpanContext(evt, metadata);
        const runId = "runId" in evt && typeof evt.runId === "string" ? evt.runId : undefined;
        if (runContext && runId) {
          trustedRunSpanContexts.delete(runId);
          return trace.setSpanContext(otelContextApi.active(), runContext.spanContext);
        }
        return activeInternalOrTrustedContext(evt, metadata);
      };
`;
const helperAnchor = "      const recordModelUsage = (";
const helperPatched = `${usageContextHelpers}${helperAnchor}`;

function occurrences(source, value) {
  return source.split(value).length - 1;
}

export function patchOpenClawDiagnosticsUsageContext(source) {
  const originalCount = occurrences(source, originalAnchor);
  const patchedCount = occurrences(source, patchedAnchor);
  const registryCount = occurrences(source, trustedRunSpanContextsDeclaration);
  const helpersCount = occurrences(source, usageContextHelpers);
  const runStartedCount = occurrences(source, runStartedPatched);
  const modelCallStartCount = occurrences(source, modelCallStartPatched);
  const cleanupCount = occurrences(source, stopContextsPatched);
  if (
    patchedCount === 1 &&
    originalCount === 0 &&
    registryCount === 1 &&
    helpersCount === 1 &&
    runStartedCount === 1 &&
    modelCallStartCount === 1 &&
    cleanupCount === 1
  ) {
    return { source, state: "already-patched" };
  }
  if (
    originalCount !== 1 ||
    patchedCount !== 0 ||
    occurrences(source, trustedRunSpanContextsAnchor) !== 1 ||
    registryCount !== 0 ||
    occurrences(source, stopContextsAnchor) !== 1 ||
    occurrences(source, runStartedAnchor) !== 1 ||
    occurrences(source, helperAnchor) !== 1 ||
    occurrences(source, modelCallStartAnchor) !== 1
  ) {
    throw new Error("OpenClaw diagnostics usage patch expected exactly one reviewed anchor.");
  }
  let patched = source.replace(
    trustedRunSpanContextsAnchor,
    `${trustedRunSpanContextsDeclaration}${trustedRunSpanContextsAnchor}`,
  );
  patched = patched.replace(stopContextsAnchor, stopContextsPatched);
  patched = patched.replace(runStartedAnchor, runStartedPatched);
  patched = patched.replace(modelCallStartAnchor, modelCallStartPatched);
  patched = patched.replace(helperAnchor, helperPatched);
  return {
    source: patched.replace(originalAnchor, patchedAnchor),
    state: "patched",
  };
}

export { usageContextHelpers as runContextHelpers };

const docsFailureMetadataHelpers = `function fridayDocsFailureMetadata(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const readOwn = (key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(details, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  };
  if (readOwn("ok") !== false) return undefined;
  const category = readOwn("category");
  const errorCode = readOwn("errorCode");
  if (typeof errorCode !== "string" || !errorCode.startsWith("DOCS_")) return undefined;
  const codes = {
    timeout: "DOCS_TIMEOUT",
    network: "DOCS_NETWORK",
    authorization: "DOCS_AUTHORIZATION",
    not_found: "DOCS_NOT_FOUND",
    rate_limit: "DOCS_RATE_LIMITED",
    http_4xx: "DOCS_HTTP_4XX",
    http_5xx: "DOCS_HTTP_5XX",
    redirect_rejected: "DOCS_REDIRECT_REJECTED",
    invalid_content: "DOCS_INVALID_CONTENT",
    response_too_large: "DOCS_RESPONSE_TOO_LARGE"
  };
  if (typeof category !== "string" || codes[category] !== errorCode) {
    return { category: "other", errorCode: "other" };
  }
  const status = readOwn("httpStatus");
  const validStatus = Number.isInteger(status) && status >= 400 && status <= 599;
  const statusMatchesCategory = validStatus && (
    category === "authorization" ? status === 401 || status === 403
      : category === "not_found" ? status === 404
        : category === "rate_limit" ? status === 429
          : category === "http_4xx" ? status >= 400 && status <= 499 && ![401, 403, 404, 429].includes(status)
            : category === "http_5xx" ? status >= 500 && status <= 599
              : false
  );
  return {
    category,
    errorCode,
    ...(statusMatchesCategory ? { httpStatus: status } : {})
  };
}
`;

const toolResultTerminalAnchor = "function resolveToolResultTerminalDiagnostic(result, durationMs) {";
const toolResultErrorReturn = [
  "\treturn {",
  '\t\ttype: "tool.execution.error",',
  "\t\tdurationMs,",
  '\t\terrorCategory: "tool_result_error",',
  "\t\tterminalReason: failureKind",
  "\t};",
].join("\n");
const toolResultErrorReturnPatched = [
  "\tconst docsFailure = fridayDocsFailureMetadata(readToolResultDetails(result));",
  "\treturn {",
  '\t\ttype: "tool.execution.error",',
  "\t\tdurationMs,",
  '\t\terrorCategory: docsFailure?.category ?? "tool_result_error",',
  "\t\tterminalReason: failureKind,",
  "\t\t...(docsFailure ? { errorCode: docsFailure.httpStatus === undefined ? docsFailure.errorCode : String(docsFailure.httpStatus) } : {})",
  "\t};",
].join("\n");

export function patchOpenClawToolResultFailure(source) {
  const originalCount = occurrences(source, toolResultErrorReturn);
  const patchedCount = occurrences(source, toolResultErrorReturnPatched);
  const helperCount = occurrences(source, docsFailureMetadataHelpers);
  const terminalCount = occurrences(source, toolResultTerminalAnchor);
  if (originalCount === 0 && patchedCount === 1 && helperCount === 1 && terminalCount === 1) {
    return { source, state: "already-patched" };
  }
  if (originalCount !== 1 || patchedCount !== 0 || helperCount !== 0 || terminalCount !== 1) {
    throw new Error("OpenClaw tool-result failure patch expected exactly one reviewed anchor.");
  }
  const withHelper = source.replace(toolResultTerminalAnchor, `${docsFailureMetadataHelpers}\n${toolResultTerminalAnchor}`);
  return { source: withHelper.replace(toolResultErrorReturn, toolResultErrorReturnPatched), state: "patched" };
}

const modelErrorFunctionAnchor = "function modelCallErrorFields(err) {";
const modelErrorModuleImport = 'import { appendLocalErrorRecord } from "/opt/friday/source/integrations/openai-docs-adapter/dist/local-error-log.js";';
const modelErrorFieldsShapeAnchor = [
  "\tconst upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);",
  "\tconst failureKind = diagnosticErrorFailureKind(err);",
  "\treturn {",
].join("\n");
const modelErrorLoggingCall = "\trecordModelCallFailureLocally(err);";
const modelErrorLoggingHelper = `function recordModelCallFailureLocally(err) {
  try {
    const readOwn = (value, key) => {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
      } catch {
        return undefined;
      }
    };
    const readOwnString = (value, key) => {
      const field = readOwn(value, key);
      return typeof field === "string" ? field : undefined;
    };
    const errorMessage = (typeof err === "string" ? err : readOwnString(err, "message")) || "Model call failed.";
    const errorStack = readOwnString(err, "stack");
    const candidateStatus = readOwn(err, "status") ?? readOwn(err, "statusCode");
    const httpStatus = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
      ? candidateStatus
      : undefined;
    const record = {
      operation: "model_call",
      errorMessage,
      ...(errorStack ? { errorStack } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus })
    };
    void appendLocalErrorRecord(record).catch(() => undefined);
  } catch {
    // Local diagnostics must never change the provider failure outcome.
  }
}
`;

export function patchOpenClawModelErrorLogging(source) {
  const functionCount = occurrences(source, modelErrorFunctionAnchor);
  const shapeCount = occurrences(source, modelErrorFieldsShapeAnchor);
  const helperCount = occurrences(source, modelErrorLoggingHelper);
  const callCount = occurrences(source, modelErrorLoggingCall);
  const importCount = occurrences(source, modelErrorModuleImport);
  if (functionCount === 1 && shapeCount === 1 && helperCount === 1 && callCount === 1 && importCount === 1) {
    return { source, state: "already-patched" };
  }
  if (functionCount !== 1 || shapeCount !== 1 || helperCount !== 0 || callCount !== 0 || importCount !== 0) {
    throw new Error("OpenClaw model-error logging patch expected exactly one reviewed anchor.");
  }
  const withImport = source.replace(modelErrorFunctionAnchor, `${modelErrorModuleImport}\n${modelErrorFunctionAnchor}`);
  const withHelper = withImport.replace(modelErrorFunctionAnchor, `${modelErrorLoggingHelper}${modelErrorFunctionAnchor}`);
  return {
    source: withHelper.replace(modelErrorFunctionAnchor, `${modelErrorFunctionAnchor}\n${modelErrorLoggingCall}`),
    state: "patched",
  };
}

export { docsFailureMetadataHelpers, modelErrorLoggingHelper };

const serviceFailureMetadataHelpers = `      const fridayFailureCategories = new Set([
        "timeout", "network", "rate_limit", "authorization", "validation", "not_found",
        "http_4xx", "http_5xx", "redirect_rejected", "invalid_content", "response_too_large",
      ]);
      const fridayDocsErrorCodes: Readonly<Record<string, string>> = {
        timeout: "DOCS_TIMEOUT",
        network: "DOCS_NETWORK",
        authorization: "DOCS_AUTHORIZATION",
        not_found: "DOCS_NOT_FOUND",
        rate_limit: "DOCS_RATE_LIMITED",
        http_4xx: "DOCS_HTTP_4XX",
        http_5xx: "DOCS_HTTP_5XX",
        redirect_rejected: "DOCS_REDIRECT_REJECTED",
        invalid_content: "DOCS_INVALID_CONTENT",
        response_too_large: "DOCS_RESPONSE_TOO_LARGE",
      };
      const fridayModelCallErrorCategory = (category: unknown, failureKind: unknown): string => {
        if (typeof category === "string" && fridayFailureCategories.has(category)) return category;
        if (failureKind === "timeout") return "timeout";
        if (failureKind === "connection_reset" || failureKind === "connection_closed") return "network";
        return "other";
      };
      const fridayToolErrorMetadata = (category: unknown, errorCode: unknown) => {
        const safeCategory = typeof category === "string" && fridayFailureCategories.has(category)
          ? category
          : "other";
        const safeCode = typeof errorCode === "string" ? errorCode : "";
        const httpStatus = /^(?:4\\d\\d|5\\d\\d)$/.test(safeCode) ? Number(safeCode) : undefined;
        const knownCodes = new Set(["AUTH_REQUIRED", "NOT_FOUND", "RATE_LIMITED"]);
        const code = fridayDocsErrorCodes[safeCategory]
          ?? (knownCodes.has(safeCode) ? safeCode : safeCode ? "other" : undefined);
        return { category: safeCategory, ...(code ? { code } : {}), ...(httpStatus === undefined ? {} : { httpStatus }) };
      };
`;
export { serviceFailureMetadataHelpers };
const serviceModelCallCategoryAnchor = [
  "      const recordModelCallError = (",
  '        evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,',
  "        metadata: DiagnosticEventMetadata,",
  "        modelContent?: OtelModelCallContent,",
  "      ) => {",
  '        const errorType = lowCardinalityAttr(evt.errorCategory, "other");',
].join("\n");
const serviceModelCallCategoryPatched = serviceModelCallCategoryAnchor.replace(
  'const errorType = lowCardinalityAttr(evt.errorCategory, "other");',
  "const errorType = fridayModelCallErrorCategory(evt.errorCategory, evt.failureKind);",
);
const serviceToolErrorAttrsAnchor = [
  "        const attrs = {",
  "          ...toolExecutionBaseAttrs(evt),",
  '          "openclaw.errorCategory": lowCardinalityAttr(evt.errorCategory, "other"),',
  "        };",
].join("\n");
const serviceToolErrorAttrsPatched = [
  "        const failureMetadata = fridayToolErrorMetadata(evt.errorCategory, evt.errorCode);",
  "        const attrs = {",
  "          ...toolExecutionBaseAttrs(evt),",
  '          "openclaw.errorCategory": failureMetadata.category,',
  "        };",
].join("\n");
const serviceToolErrorCodeAnchor = [
  "        if (evt.errorCode) {",
  '          spanAttrs["openclaw.errorCode"] = lowCardinalityAttr(evt.errorCode, "other");',
  "        }",
].join("\n");
const serviceToolErrorCodePatched = [
  '        if (failureMetadata.httpStatus !== undefined) spanAttrs["http.response.status_code"] = failureMetadata.httpStatus;',
  "        if (evt.errorCode && failureMetadata.code) {",
  '          spanAttrs["openclaw.errorCode"] = failureMetadata.code;',
  "        }",
].join("\n");

export function patchOpenClawDiagnosticsFailureMetadata(source) {
  const helperCount = occurrences(source, serviceFailureMetadataHelpers);
  const originalModelCount = occurrences(source, serviceModelCallCategoryAnchor);
  const patchedModelCount = occurrences(source, serviceModelCallCategoryPatched);
  const originalToolAttrsCount = occurrences(source, serviceToolErrorAttrsAnchor);
  const patchedToolAttrsCount = occurrences(source, serviceToolErrorAttrsPatched);
  const originalToolCodeCount = occurrences(source, serviceToolErrorCodeAnchor);
  const patchedToolCodeCount = occurrences(source, serviceToolErrorCodePatched);
  if (
    helperCount === 1 && originalModelCount === 0 && patchedModelCount === 1
    && originalToolAttrsCount === 0 && patchedToolAttrsCount === 1
    && originalToolCodeCount === 0 && patchedToolCodeCount === 1
  ) return { source, state: "already-patched" };
  if (
    helperCount !== 0 || originalModelCount !== 1 || patchedModelCount !== 0
    || originalToolAttrsCount !== 1 || patchedToolAttrsCount !== 0
    || originalToolCodeCount !== 1 || patchedToolCodeCount !== 0
  ) throw new Error(`OpenClaw diagnostics failure-metadata patch expected exactly one reviewed anchor (helper=${helperCount}, model=${originalModelCount}/${patchedModelCount}, attrs=${originalToolAttrsCount}/${patchedToolAttrsCount}, code=${originalToolCodeCount}/${patchedToolCodeCount}).`);

  let patched = source.replace(serviceModelCallCategoryAnchor, serviceModelCallCategoryPatched);
  patched = patched.replace(serviceModelCallCategoryPatched, `${serviceFailureMetadataHelpers}${serviceModelCallCategoryPatched}`);
  patched = patched.replace(serviceToolErrorAttrsAnchor, serviceToolErrorAttrsPatched);
  patched = patched.replace(serviceToolErrorCodeAnchor, serviceToolErrorCodePatched);
  return { source: patched, state: "patched" };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const packageJson = JSON.parse(await readFile("/app/package.json", "utf8"));
  if (packageJson.name !== "openclaw" || packageJson.version !== "2026.7.1") {
    throw new Error("Unsupported OpenClaw package.");
  }
  const [before, toolResultBefore, modelErrorBefore, diagnosticErrorMetadata] = await Promise.all([
    readFile(upstreamPath),
    readFile(toolResultUpstreamPath),
    readFile(modelErrorUpstreamPath),
    readFile(diagnosticErrorMetadataPath),
  ]);
  if (sha256(before) !== upstreamSha256) {
    throw new Error("Unsupported OpenClaw diagnostics plugin bytes.");
  }
  if (sha256(toolResultBefore) !== toolResultUpstreamSha256) {
    throw new Error("Unsupported OpenClaw tool-result diagnostics bytes.");
  }
  if (sha256(modelErrorBefore) !== modelErrorUpstreamSha256) {
    throw new Error("Unsupported OpenClaw model diagnostics bytes.");
  }
  if (sha256(diagnosticErrorMetadata) !== diagnosticErrorMetadataSha256) {
    throw new Error("Unsupported OpenClaw diagnostic error metadata bytes.");
  }

  const usageResult = patchOpenClawDiagnosticsUsageContext(before.toString("utf8"));
  const diagnosticsResult = patchOpenClawDiagnosticsFailureMetadata(usageResult.source);
  const toolResult = patchOpenClawToolResultFailure(toolResultBefore.toString("utf8"));
  const modelError = patchOpenClawModelErrorLogging(modelErrorBefore.toString("utf8"));
  if (!apply) {
    process.stdout.write("Pinned OpenClaw diagnostics, tool-result, and model-error anchors verified; no files changed.\n");
    return;
  }
  const targets = [
    { path: upstreamPath, contents: diagnosticsResult.source },
    { path: toolResultUpstreamPath, contents: toolResult.source },
    { path: modelErrorUpstreamPath, contents: modelError.source },
  ];
  const temporaryPaths = [];
  try {
    for (const target of targets) {
      const temporary = `${target.path}.friday-diagnostics-fix-tmp`;
      await writeFile(temporary, target.contents, { flag: "wx", mode: 0o644 });
      temporaryPaths.push({ temporary, target: target.path });
    }
    for (const { temporary, target } of temporaryPaths) await rename(temporary, target);
  } finally {
    await Promise.all(temporaryPaths.map(({ temporary }) => unlink(temporary).catch(() => undefined)));
  }
  process.stdout.write("Pinned OpenClaw failure metadata and local diagnostics patched during image build.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
