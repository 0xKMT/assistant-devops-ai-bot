/**
 * Scans distributable text files for personal paths, credentials and host-only
 * metadata. Runtime/generated directories are excluded because they must never
 * be part of the source archive in the first place.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", ".superpowers", "backups", "build", "dist", "node_modules", "secrets"]);
const ignoredFiles = new Set([
  path.join(root, "config", "instance.json"),
  path.join(root, "config", "instance.container.json"),
  path.join(root, "container", ".env"),
]);
const textExtensions = new Set([
  ".cjs", ".js", ".json", ".json5", ".md", ".mjs", ".mmd", ".patch",
  ".plist", ".sh", ".ts", ".yaml", ".yml",
]);
const forbidden = [
  { label: "personal macOS home path", pattern: /\/Users\/(?!alex(?:\/|$)|example(?:\/|$)|user(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/ },
  { label: "personal Linux home path", pattern: /\/home\/(?!alex(?:\/|$)|example(?:\/|$)|node(?:\/|$)|user(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/ },
  { label: "non-example email address", pattern: /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "Slack bot token", pattern: /\bxoxb-[A-Za-z0-9-]{12,}\b/ },
  { label: "Slack app token", pattern: /\bxapp-[A-Za-z0-9-]{12,}\b/ },
  { label: "GitHub token", pattern: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "private key", pattern: /-----BEGIN [^-\n]*PRIVATE KEY-----/ },
];
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.name === ".DS_Store") {
      findings.push(`${path.relative(root, file)} (macOS metadata)`);
      continue;
    }
    if (ignoredFiles.has(file)) continue;
    if (file === import.meta.filename) continue;
    if (entry.isDirectory()) await walk(file);
    else if (
      textExtensions.has(path.extname(entry.name))
      || entry.name === ".gitignore"
      || entry.name === ".dockerignore"
      || entry.name === "Dockerfile"
    ) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const rule of forbidden) {
          if (rule.pattern.test(line)) findings.push(`${path.relative(root, file)}:${index + 1} (${rule.label})`);
        }
      });
    }
  }
}

await walk(root);
if (findings.length) {
  process.stderr.write(`Portability and secret audit failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("Portability and secret audit passed.\n");
