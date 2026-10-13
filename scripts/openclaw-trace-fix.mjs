import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const upstreamPath = "/app/dist/selection-JInn13lc.js";
const upstreamSha256 = "ccff13111aa60369ac9d88b526a58a7df1f733f1d99d205c01c6186036957e66";
const originalAnchor = [
  "\t\t\t\tsessionFileUsed,",
  "\t\t\t\tdiagnosticTrace,",
  "\t\t\t\tbootstrapPromptWarningSignaturesSeen:",
].join("\n");
const patchedAnchor = originalAnchor.replace("diagnosticTrace,", "diagnosticTrace: runTrace,");

function occurrences(source, value) {
  return source.split(value).length - 1;
}

export function patchOpenClawTraceContext(source) {
  const originalCount = occurrences(source, originalAnchor);
  const patchedCount = occurrences(source, patchedAnchor);
  if (patchedCount === 1 && originalCount === 0) {
    return { source, state: "already-patched" };
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error("OpenClaw trace context patch expected exactly one reviewed anchor.");
  }
  return {
    source: source.replace(originalAnchor, patchedAnchor),
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
    throw new Error("Unsupported OpenClaw trace source bytes.");
  }
  const result = patchOpenClawTraceContext(before.toString("utf8"));
  if (!apply) {
    process.stdout.write("Pinned OpenClaw trace context anchor verified; no files changed.\n");
    return;
  }
  const temporary = `${upstreamPath}.friday-trace-fix-tmp`;
  await writeFile(temporary, result.source, { flag: "wx", mode: 0o644 });
  await rename(temporary, upstreamPath);
  process.stdout.write("Pinned OpenClaw trace context patched during image build.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
