import { readFile } from "node:fs/promises";
import { evaluateCases } from "./lib/golden-eval.mjs";

try {
  const source = await readFile(new URL("../eval/golden/container-v1.jsonl", import.meta.url), "utf8");
  const rows = source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const results = evaluateCases(rows);
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
  const passed = results.filter((result) => result.passed).length;
  const summary = { datasetVersion: "container-v1", total: results.length, passed, failed: results.length - passed };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.failed) process.exitCode = 1;
} catch {
  process.stderr.write("Golden evaluation input is invalid.\n");
  process.exitCode = 1;
}
