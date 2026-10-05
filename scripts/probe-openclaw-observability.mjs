#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";

import { inspectOpenClawObservability } from "./lib/openclaw-observability-probe.mjs";

const expectedVersion = "2026.7.1-2";
const args = process.argv.slice(2);
const executableIndex = args.indexOf("--executable");
const requestedExecutable = executableIndex === -1 ? null : args[executableIndex + 1];
const executablePath = requestedExecutable ?? await resolveFromPath("openclaw");
const report = await inspectOpenClawObservability({ executablePath, expectedVersion });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = {
  "validated-declarations": 0,
  "missing-executable": 2,
  "version-mismatch": 3,
  "inconclusive-declarations": 4,
}[report.evidence] ?? 4;

async function resolveFromPath(executableName) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the bounded PATH entries.
    }
  }
  return executableName;
}
