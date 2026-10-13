import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const upstreamPath = "/app/dist/agent-command-ABV9I5el.js";
const upstreamSha256 = "e44528f0fa46bd3e5e0e4be6c279a1a499f1b5c224fe760cf67dec4e2b641aee";
const usageTypeAnchor = 'type: "model.usage",';
const returnAnchor = "return deliveryResult;";
const usageRunIdLine = "...typeof opts?.runId === \"string\" ? { runId: opts.runId } : {},";
const usageTraceLine = "...result.diagnosticTrace ? { trace: result.diagnosticTrace } : {},";
const resultTraceLine = "...result.diagnosticTrace ? { diagnosticTrace: result.diagnosticTrace } : {},";

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function lineIndent(source, anchor) {
  const index = source.indexOf(anchor);
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const indent = source.slice(lineStart, index);
  if (!/^[\t ]*$/.test(indent)) {
    throw new Error("OpenClaw ingress trace patch anchor must start on its own line.");
  }
  return indent;
}

function replaceUniqueLine(source, anchor, replacement) {
  if (occurrences(source, anchor) !== 1) {
    throw new Error("OpenClaw ingress trace patch expected exactly one reviewed anchor.");
  }
  const indent = lineIndent(source, anchor);
  return source.replace(anchor, `${replacement(indent)}`);
}

export function patchOpenClawIngressUsageTrace(source) {
  const originalUsageCount = occurrences(source, usageTypeAnchor);
  const originalReturnCount = occurrences(source, returnAnchor);
  const patchedRunIdCount = occurrences(source, usageRunIdLine);
  const patchedUsageCount = occurrences(source, usageTraceLine);
  const patchedResultCount = occurrences(source, resultTraceLine);
  if (
    originalUsageCount === 1 &&
    originalReturnCount === 0 &&
    patchedRunIdCount === 1 &&
    patchedUsageCount === 1 &&
    patchedResultCount === 1
  ) {
    return { source, state: "already-patched" };
  }
  if (
    originalUsageCount !== 1 ||
    originalReturnCount !== 1 ||
    patchedRunIdCount !== 0 ||
    patchedUsageCount !== 0 ||
    patchedResultCount !== 0
  ) {
    throw new Error("OpenClaw ingress trace patch expected exactly one reviewed anchor.");
  }

  let patched = replaceUniqueLine(source, returnAnchor, (indent) => [
    `${indent}return {`,
    `${indent}\t...deliveryResult,`,
    `${indent}\t${resultTraceLine}`,
    `${indent}};`,
  ].join("\n"));
  patched = replaceUniqueLine(patched, usageTypeAnchor, (indent) => [
    `${indent}${usageTypeAnchor}`,
    `${indent}${usageRunIdLine}`,
    `${indent}${usageTraceLine}`,
  ].join("\n"));
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
  const before = await readFile(upstreamPath);
  if (sha256(before) !== upstreamSha256) {
    throw new Error("Unsupported OpenClaw ingress command bytes.");
  }
  const result = patchOpenClawIngressUsageTrace(before.toString("utf8"));
  if (!apply) {
    process.stdout.write("Pinned OpenClaw ingress usage trace anchors verified; no files changed.\n");
    return;
  }
  const temporary = `${upstreamPath}.friday-ingress-trace-fix-tmp`;
  await writeFile(temporary, result.source, { flag: "wx", mode: 0o644 });
  await rename(temporary, upstreamPath);
  process.stdout.write("Pinned OpenClaw ingress usage trace context patched during image build.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
