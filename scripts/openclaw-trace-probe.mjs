import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const pinnedPackageVersion = "2026.7.1";
const targets = {
  host: {
    path: "/app/dist/agent-runner.runtime-DtdxZiBX.js",
    sha256: "75d5a85275050907ef0deeb9a63b1fcdcdcf00a9077985baef590f3ce4783ae8",
  },
  plugin: {
    path: "/app/extensions/diagnostics-otel/src/service.ts",
    sha256: "1f321f391de6ba0dc6429588d572d710de252826aa2036ee6d63f50c71fe95c2",
  },
};

const hostAnchor = [
  "\t\t\temitTrustedDiagnosticEvent({",
  '\t\t\t\ttype: "model.usage",',
  "\t\t\t\trunId,",
  "\t\t\t\t...runResult.diagnosticTrace ? { trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runResult.diagnosticTrace)) } : {},",
  "\t\t\t\tsessionKey,",
].join("\n");
const hostPatchedAnchor = [
  '\t\t\tprocess.stderr.write("FRIDAY_TRACE_PROBE_RESULT=" + (runResult.diagnosticTrace ? "present" : "absent") + "\\n");',
  hostAnchor,
].join("\n");

const pluginAnchor = [
  '        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {',
  "          parentContext: modelUsageParentContext(evt, metadata),",
  "          endTimeMs: evt.ts,",
  "        });",
].join("\n");
const pluginPatchedAnchor = [
  "        const trustedParentSpanId = trustedTraceContext(evt, metadata)?.parentSpanId;",
  "        const parentContext = modelUsageParentContext(evt, metadata);",
  '        const parentStatus = !trustedParentSpanId ? "missing_event_trace" : parentContext ? "resolved_parent" : "lost_trusted_parent";',
  '        process.stderr.write(`FRIDAY_TRACE_PROBE_PARENT=${parentStatus}\\n`);',
  pluginAnchor.replace("modelUsageParentContext(evt, metadata)", "parentContext"),
].join("\n");

function occurrences(source, value) {
  return source.split(value).length - 1;
}

export function patchTraceProbe(source, kind) {
  const anchor = kind === "host" ? hostAnchor : kind === "plugin" ? pluginAnchor : undefined;
  const patchedAnchor = kind === "host" ? hostPatchedAnchor : kind === "plugin" ? pluginPatchedAnchor : undefined;
  const marker = kind === "host" ? "FRIDAY_TRACE_PROBE_RESULT=" : kind === "plugin" ? "FRIDAY_TRACE_PROBE_PARENT=" : undefined;
  if (!anchor || !patchedAnchor || !marker) throw new TypeError("Trace probe target kind must be host or plugin.");

  const anchorCount = occurrences(source, anchor);
  const patchedCount = occurrences(source, patchedAnchor);
  const markerCount = occurrences(source, marker);
  const retainedAnchorCount = kind === "host" ? 1 : 0;
  if (anchorCount === retainedAnchorCount && patchedCount === 1 && markerCount === 1) {
    return { source, state: "already-patched" };
  }
  if (anchorCount !== 1 || patchedCount !== 0 || markerCount !== 0) {
    throw new Error(`Pinned OpenClaw ${kind} trace-probe patch expected exactly one reviewed anchor.`);
  }
  return { source: source.replace(anchor, patchedAnchor), state: "patched" };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function replaceAtomically(path, contents) {
  const temporary = `${path}.friday-trace-probe-tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const packageJson = JSON.parse(await readFile("/app/package.json", "utf8"));
  if (packageJson.name !== "openclaw" || packageJson.version !== pinnedPackageVersion) {
    throw new Error("Unsupported OpenClaw package for trace probe.");
  }

  const before = await Promise.all(
    Object.entries(targets).map(async ([kind, target]) => {
      const contents = await readFile(target.path);
      if (sha256(contents) !== target.sha256) {
        throw new Error(`Unsupported OpenClaw ${kind} trace-probe source bytes.`);
      }
      return { kind, path: target.path, source: contents.toString("utf8") };
    }),
  );
  const patched = before.map(({ kind, path, source }) => ({
    path,
    source: patchTraceProbe(source, kind).source,
  }));

  if (!apply) {
    process.stdout.write("Pinned OpenClaw trace-probe anchors verified; no files changed.\n");
    return;
  }
  for (const target of patched) await replaceAtomically(target.path, target.source);
  process.stdout.write("Pinned OpenClaw trace probe installed; output is limited to reviewed enums.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
