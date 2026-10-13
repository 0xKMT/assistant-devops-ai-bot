import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const upstreamPath = "/app/dist/agent-runner.runtime-DtdxZiBX.js";
const upstreamSha256 = "37e2d3f40651107f5fa9abe76ccc9b2345497f952991dec50a2d18eaf8c35c42";
const usageTypeAnchor = 'type: "model.usage",';

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function lineIndent(source, anchor) {
  const index = source.indexOf(anchor);
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const indent = source.slice(lineStart, index);
  if (!/^[\t ]*$/.test(indent)) {
    throw new Error("OpenClaw runner usage trace patch anchor must start on its own line.");
  }
  return indent;
}

export function patchOpenClawRunnerUsageTrace(source) {
  const originalCount = source.split(usageTypeAnchor).length - 1;
  const patchedPattern = /type: "model\.usage",\n[\t ]*runId,/g;
  const patchedCount = occurrences(source, patchedPattern);
  if (originalCount === 1 && patchedCount === 1) {
    return { source, state: "already-patched" };
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error("OpenClaw runner usage trace patch expected exactly one reviewed anchor.");
  }
  const indent = lineIndent(source, usageTypeAnchor);
  return {
    source: source.replace(usageTypeAnchor, `${usageTypeAnchor}\n${indent}runId,`),
    state: "patched",
  };
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
    throw new Error("Unsupported OpenClaw runner usage source bytes.");
  }
  const result = patchOpenClawRunnerUsageTrace(before.toString("utf8"));
  if (!apply) {
    process.stdout.write("Pinned OpenClaw runner usage trace anchor verified; no files changed.\n");
    return;
  }
  const temporary = `${upstreamPath}.friday-runner-trace-fix-tmp`;
  await writeFile(temporary, result.source, { flag: "wx", mode: 0o644 });
  await rename(temporary, upstreamPath);
  process.stdout.write("Pinned OpenClaw runner usage events now include their run ID during image build.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
