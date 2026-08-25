import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const generator = await readFile(new URL("../prepare-instance.mjs", import.meta.url), "utf8");
const agentPolicy = await readFile(new URL("../../templates/workspace/AGENTS.md", import.meta.url), "utf8");
const sharedSchemas = await readFile(new URL("../../core/shared/src/schemas.ts", import.meta.url), "utf8");
const gitAdapter = await readFile(new URL("../../integrations/git-adapter/index.ts", import.meta.url), "utf8");
const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

test("Slack review routing exposes only the canonical unified review tools", () => {
  assert.match(generator, /alsoAllow: \["friday_unified_pr_review", "friday_batch_pr_review", "friday_jira_get_context", "friday_jira_prepare_ticket"\]/);
  assert.doesNotMatch(generator, /alsoAllow: \[[^\]]*friday_gitops_review/);
  assert.match(agentPolicy, /The tool gate is authoritative/);
  assert.match(agentPolicy, /Never upgrade a PASS\/WARN to BLOCK or NEEDS_HUMAN/);
});

test("instance generator preserves ordered configured model fallbacks", () => {
  assert.match(generator, /const fallbackModels = configuredModels\.filter/);
  assert.match(generator, /fallbacks: fallbackModels/);
  assert.match(generator, /models: Object\.fromEntries\(configuredModels\.map/);
});

test("instance generator renders a per-account wildcard channel policy", () => {
  assert.match(generator, /account\.channelId === "\*"/);
  assert.match(generator, /\.filter\(\(account\) => account\.channelId !== "\*"\)/);
  assert.match(generator, /groupPolicy: account\.channelId === "\*" \? "open" : "allowlist"/);
});

test("Slack review has one full-review contract", () => {
  assert.doesNotMatch(sharedSchemas, /reviewMode:/);
  assert.doesNotMatch(sharedSchemas, /outputDetail:/);
  assert.match(gitAdapter, /always runs full deterministic validation/);
  assert.match(agentPolicy, /review nhanh.*same full review/s);
  assert.match(agentPolicy, /review chi tiết.*same full review/s);
  assert.match(agentPolicy, /Findings & actions/);
  assert.match(agentPolicy, /Evidence/);
  assert.match(agentPolicy, /Limitations/);
  assert.doesNotMatch(agentPolicy, /outputDetail/);
});

test("single-review policy renders only bounded action-adjacent snippets", () => {
  assert.match(agentPolicy, /Only use snippets returned by the adapter/);
  assert.match(agentPolicy, /immediately below the related Findings & actions item/);
  assert.match(agentPolicy, /at most two snippets/);
  assert.match(agentPolicy, /at most eight lines/);
  assert.match(agentPolicy, /PASS.*never.*snippet/i);
  assert.match(agentPolicy, /snippet\.rendered exactly/);
  assert.match(agentPolicy, /exactly snippet\.language/);
  assert.match(agentPolicy, /otherwise no language label/);
  assert.match(agentPolicy, /Never reconstruct or decode/);
});

test("operator documentation describes one full review", () => {
  assert.match(readme, /one full review/i);
  assert.match(readme, /changed-file context/i);
  assert.doesNotMatch(readme, /review nhanh` chỉ là triage/);
  assert.doesNotMatch(readme, /review chi tiết` có thể đính kèm/);
});
