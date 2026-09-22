import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documentUrl = new URL("../../docs/RUNTIME_AND_DATA_OWNERSHIP.md", import.meta.url);

test("runtime ownership documentation preserves current and target boundaries", async () => {
  const document = await readFile(documentUrl, "utf8");

  for (const heading of [
    "State labels",
    "Runtime ownership",
    "Database ownership",
    "Filesystem ownership",
    "Recovery boundaries",
    "Evidence limits",
  ]) assert.match(document, new RegExp(`^## ${heading}$`, "m"), `missing heading: ${heading}`);

  for (const fact of [
    "OpenClaw Gateway",
    "Security Shield",
    "friday-security.sqlite",
    "Git Adapter",
    "friday-cache.sqlite",
    "Jira Adapter",
    "friday-jira.sqlite",
    "Slack Recovery",
    "friday-slack-watchdog.json",
    "api.runtime.state.resolveStateDir()",
    "cacheDir",
    "friday-learning.sqlite",
    "Target, not current",
  ]) assert.ok(document.includes(fact), `missing ownership fact: ${fact}`);
});
