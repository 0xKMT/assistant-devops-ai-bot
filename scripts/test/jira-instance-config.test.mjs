import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("instance preparation renders the bounded Jira workflow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "friday-jira-instance-"));
  const configPath = path.join(tempDir, "instance.json");
  const buildDir = path.join(tempDir, "build");
  const executable = process.execPath;
  const config = {
    assistant: { name: "Friday", ownerEmail: "operator@example.net", language: "en", timezone: "Asia/Ho_Chi_Minh" },
    modelBackend: { profile: "codex", primaryModel: "openai/gpt-5.6-sol", command: "" },
    runtime: { openclawVersion: "2026.7.1-2", nodeMajor: 24 },
    slack: { accounts: [{
      accountId: "everfit", accountName: "Friday Everfit", workspaceId: "TEVERFIT1", channelId: "CEVERFIT1", userId: "UEVERFIT1",
      botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_EVERFIT_SLACK_APP_TOKEN",
    }] },
    jira: {
      baseUrl: "https://example.atlassian.net", emailEnv: "FRIDAY_JIRA_EMAIL", apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN",
      projectId: "10001", projectKey: "ED", assigneeAccountId: "jira-account-id", defaultPriorityId: "3", storyPointFieldId: "customfield_10028",
      allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" },
      epicJql: "project = ED AND issuetype = Epic AND statusCategory != Done", maxEpicCandidates: 25,
      draftTtlMinutes: 1440, maxCreateAttempts: 3,
    },
    repositories: [{
      slug: "Everfit-io/devops-ai-toolkit", root, remoteUrl: "https://github.com/Everfit-io/devops-ai-toolkit.git", baseBranch: "main",
    }],
    binaries: Object.fromEntries(["git", "gh", "ssh", "tflint", "trivy", "helm", "kustomize", "kubeconform"].map((name) => [name, executable])),
    paths: {
      openclawStateDir: path.join(tempDir, "state"), workspace: path.join(tempDir, "workspace"), cacheDir: path.join(tempDir, "cache"),
      processHome: tempDir, processPath: "/usr/local/bin:/usr/bin:/bin",
    },
  };
  await writeFile(configPath, JSON.stringify(config));

  const result = spawnSync(process.execPath, ["scripts/prepare-instance.mjs", "--config", configPath], {
    cwd: root, encoding: "utf8", env: { ...process.env, FRIDAY_BUILD_DIR: buildDir },
  });
  assert.equal(result.status, 0, result.stderr);

  const patch = JSON.parse(await readFile(path.join(buildDir, "openclaw.patch.json"), "utf8"));
  assert.equal(patch.channels.slack.capabilities.interactiveReplies, true);
  assert.equal(patch.plugins.entries["friday-jira-adapter"].enabled, true);
  assert.equal(patch.plugins.entries["friday-jira-adapter"].config.jira.projectKey, "ED");
  assert.equal(patch.plugins.entries["friday-jira-adapter"].config.jira.storyPointFieldId, "customfield_10028");
  assert.equal(patch.plugins.entries["friday-jira-adapter"].config.slack.workspaceId, "TEVERFIT1");
  assert.ok(patch.plugins.allow.includes("friday-jira-adapter"));
  assert.ok(patch.tools.alsoAllow.includes("friday_jira_get_context"));
  assert.ok(patch.tools.alsoAllow.includes("friday_jira_prepare_ticket"));
  assert.ok(!patch.tools.alsoAllow.some((name) => name.includes("create")));

  const agentsPolicy = await readFile(path.join(buildDir, "workspace", "AGENTS.md"), "utf8");
  const toolsPolicy = await readFile(path.join(buildDir, "workspace", "TOOLS.md"), "utf8");
  for (const policy of [agentsPolicy, toolsPolicy]) {
    const normalized = policy.replace(/\s+/g, " ");
    assert.match(normalized, /source Slack thread/i);
    assert.match(normalized, /requester-only.*preview/i);
    assert.match(normalized, /Approve & Create/);
    assert.match(normalized, /callback-only/i);
    assert.match(normalized, /never.*model-facing.*Jira.*create/i);
  }
});
