import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("public repository ignores local runtime state and documents container deployment", async () => {
  const ignoreLines = new Set((await readFile(new URL(".gitignore", root), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean));

  for (const required of [
    "node_modules/", "build/", "dist/", ".DS_Store", ".gitnexus/", "*.log", "*.sqlite*", "*.tgz",
    "container/.env", "container/secrets/", "container/backups/",
    "config/instance.json", "config/instance.container.json",
  ]) assert.ok(ignoreLines.has(required), `missing ignore rule: ${required}`);

  assert.ok(ignoreLines.has("build/"), "generated Compose secret mappings must stay ignored");
  assert.ok(ignoreLines.has("container/secrets/"), "account token files must stay ignored");

  const dockerIgnoreLines = new Set((await readFile(new URL(".dockerignore", root), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean));
  assert.ok(dockerIgnoreLines.has(".gitnexus"), "local GitNexus state must stay outside image contexts");

  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const heading of ["# Friday", "## Features", "## Technology Stack", "## Container Deployment"]) {
    assert.match(readme, new RegExp(`^${heading}$`, "m"), `missing README heading: ${heading}`);
  }

  for (const removedPath of [
    "docs/DEVELOPMENT_PROCESS.md",
    "docs/SETUP.md",
    "docs/superpowers",
    "scripts/test/fast-review-contract.test.mjs",
  ]) {
    await assert.rejects(access(new URL(removedPath, root)), `stale public-tree path remains: ${removedPath}`);
  }
  await access(new URL("scripts/test/single-review-contract.test.mjs", root));
});

test("container image builds and installs the Jira adapter artifact required by bootstrap", async () => {
  const dockerfile = await readFile(new URL("Dockerfile", root), "utf8");
  assert.match(dockerfile, /npm run build --workspace @friday\/jira-adapter/);
  assert.match(
    dockerfile,
    /COPY --from=friday-build \/src\/integrations\/jira-adapter\/dist \/opt\/friday\/source\/integrations\/jira-adapter\/dist/,
  );
});
