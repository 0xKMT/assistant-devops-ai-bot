import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observabilityConfig } from "./lib/observability-config.mjs";

export async function render(inputPath, outputPath) {
  const source = await readFile(inputPath, "utf8");
  const rendered = observabilityConfig(JSON.parse(source));
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(rendered, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    process.stderr.write("Expected an input and output config path.\n");
    process.exitCode = 2;
  } else {
    render(process.argv[2], process.argv[3]).catch(() => {
      process.stderr.write("Observability config rendering failed.\n");
      process.exitCode = 1;
    });
  }
}
