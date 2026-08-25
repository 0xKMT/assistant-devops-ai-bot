import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");

test("renderer maps one Docker secret pair per Slack account without token values", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "friday-slack-secrets-"));
  const configPath = path.join(tempDir, "instance.json");
  const outputPath = path.join(tempDir, "container-secrets.compose.yaml");
  await writeFile(configPath, JSON.stringify({
    slack: {
      accounts: [
        {
          accountId: "infra-review",
          accountName: "Friday Infra",
          workspaceId: "TINFRA01",
          channelId: "CINFRA01",
          userId: "UINFRA01",
          botTokenEnv: "FRIDAY_INFRA_SLACK_BOT_TOKEN",
          appTokenEnv: "FRIDAY_INFRA_SLACK_APP_TOKEN",
        },
        {
          accountId: "everfit",
          accountName: "Friday Everfit",
          workspaceId: "TEVERFIT1",
          channelId: "CEVERFIT1",
          userId: "UEVERFIT1",
          botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN",
          appTokenEnv: "FRIDAY_EVERFIT_SLACK_APP_TOKEN",
        },
      ],
    },
    jira: { apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN" },
  }));

  const result = spawnSync(process.execPath, [
    "scripts/render-container-secrets.mjs", "--config", configPath, "--output", outputPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const yaml = await readFile(outputPath, "utf8");
  for (const secret of [
    "friday_slack_infra_review_bot_token",
    "friday_slack_infra_review_app_token",
    "friday_slack_everfit_bot_token",
    "friday_slack_everfit_app_token",
  ]) assert.match(yaml, new RegExp(`target: ${secret}`));
  assert.match(yaml, /file: \.\/container\/secrets\/slack-infra-review-bot-token/);
  assert.match(yaml, /file: \.\/container\/secrets\/slack-everfit-app-token/);
  assert.doesNotMatch(yaml, /xox[bap]-|token-value|secret-value/i);
});

test("container initialization preserves Jira and Slack secret values owner-only without disclosure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "friday-jira-secrets-"));
  const configDir = path.join(tempDir, "config");
  const secretsDir = path.join(tempDir, "container", "secrets");
  const jiraToken = "redacted-jira-value";
  const slackToken = "redacted-slack-bot-value";
  await mkdir(configDir, { recursive: true });
  await mkdir(secretsDir, { recursive: true });
  await writeFile(path.join(tempDir, "container", ".env"), "FRIDAY_IMAGE_TAG=test\n");
  await writeFile(path.join(configDir, "instance.container.json"), JSON.stringify({
    slack: { accounts: [{
      accountId: "everfit", accountName: "Friday Everfit", workspaceId: "TEVERFIT1", channelId: "CEVERFIT1", userId: "UEVERFIT1",
      botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_EVERFIT_SLACK_APP_TOKEN",
    }] },
    jira: { apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN" },
  }));
  const jiraPath = path.join(secretsDir, "jira-api-token");
  const slackPath = path.join(secretsDir, "slack-everfit-bot-token");
  await writeFile(jiraPath, jiraToken, { mode: 0o644 });
  await writeFile(slackPath, slackToken, { mode: 0o644 });

  const result = spawnSync(process.execPath, ["scripts/container-init.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FRIDAY_CONTAINER_INIT_ROOT: tempDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${jiraToken}|${slackToken}`));
  assert.equal(await readFile(jiraPath, "utf8"), jiraToken);
  assert.equal(await readFile(slackPath, "utf8"), slackToken);
  assert.equal((await stat(jiraPath)).mode & 0o777, 0o600);
  assert.equal((await stat(slackPath)).mode & 0o777, 0o600);
});
