import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_HOME_LOCKDOWN_TOML,
  codexHomeConfigPath,
  installCodexHomeConfig,
  mergeCodexHomeConfig,
} from "../lib/codex-home-config.mjs";

test("codex-home lockdown disables native shell, exec and app surfaces", () => {
  for (const line of [
    "shell_tool = false",
    "unified_exec = false",
    "apps = false",
    "browser_use = false",
    "computer_use = false",
    "multi_agent = false",
    'web_search = "disabled"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
  ]) {
    assert.ok(CODEX_HOME_LOCKDOWN_TOML.includes(line), line);
  }
});

test("merge keeps only project trust tables and drops stale overrides", () => {
  const existing = [
    'sandbox_mode = "danger-full-access"',
    "[features]",
    "shell_tool = true",
    '[projects."/home/node/.openclaw/workspace"]',
    'trust_level = "trusted"',
    "[mcp_servers.evil] # comment",
    'command = "sh"',
    '[projects."/w2"] # trailing comment',
    'trust_level = "untrusted"',
    'command = "sh"',
    "[[profiles.x]]",
    'trust_level = "trusted"',
    '[ projects."/w3".nested ]',
    'trust_level = "trusted"',
  ].join("\n");
  const merged = mergeCodexHomeConfig(existing);
  assert.ok(merged.startsWith(CODEX_HOME_LOCKDOWN_TOML.trimEnd()));
  assert.ok(merged.includes('[projects."/home/node/.openclaw/workspace"]\ntrust_level = "trusted"'));
  assert.ok(!merged.includes("danger-full-access"));
  assert.ok(!merged.includes("shell_tool = true"));
  assert.ok(!merged.includes("mcp_servers"));
  assert.ok(!merged.includes('command = "sh"'));
  assert.ok(!merged.includes("profiles"));
  assert.ok(!merged.includes("/w3"));
  assert.ok(merged.includes('[projects."/w2"]\ntrust_level = "untrusted"'));
  assert.equal(mergeCodexHomeConfig(merged), merged);
  assert.equal(mergeCodexHomeConfig(""), `${CODEX_HOME_LOCKDOWN_TOML.trimEnd()}\n`);
});

test("install writes the per-agent codex-home config owner-only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "friday-codex-home-"));
  try {
    const managedPath = path.join(tempDir, "codex-home.config.toml");
    await writeFile(managedPath, CODEX_HOME_LOCKDOWN_TOML);
    const target = codexHomeConfigPath(tempDir);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '[projects."/w"]\ntrust_level = "trusted"\n');
    assert.equal(await installCodexHomeConfig({ stateDir: tempDir, managedPath }), target);
    const written = await readFile(target, "utf8");
    assert.ok(written.includes("shell_tool = false"));
    assert.ok(written.includes('[projects."/w"]'));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
