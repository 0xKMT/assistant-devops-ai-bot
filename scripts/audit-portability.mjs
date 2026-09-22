import path from "node:path";
import { auditPortability } from "./lib/portability-audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const findings = await auditPortability(root);
if (findings.length) {
  process.stderr.write(`Portability and secret audit failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("Portability and secret audit passed.\n");
