import assert from "node:assert/strict";
import test from "node:test";
import { parseJiraRuntimeConfig } from "../runtime-config.js";

const valid = {
  jira: {
    baseUrl: "https://everfit.atlassian.net",
    emailEnv: "FRIDAY_JIRA_EMAIL",
    apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN",
    projectId: "10001",
    projectKey: "ED",
    assigneeAccountId: "712020:tri",
    defaultPriorityId: "3",
    storyPointFieldId: "customfield_10028",
    allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" },
    epicJql: "project = ED AND issuetype = Epic AND statusCategory != Done",
    maxEpicCandidates: 25,
  },
  slack: { accountId: "everfit", workspaceId: "T-EVERFIT", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN" },
  workflow: { draftTtlMinutes: 1440, maxCreateAttempts: 3 },
};

const secrets = {
  FRIDAY_JIRA_EMAIL: "tri@example.com",
  FRIDAY_EVERFIT_JIRA_API_TOKEN: "secret",
  FRIDAY_EVERFIT_SLACK_BOT_TOKEN: "xoxb-secret",
};

test("parses immutable bounded ED configuration", () => {
  const config = parseJiraRuntimeConfig(valid, secrets);
  assert.equal(config.jira.projectKey, "ED");
  assert.equal(config.jira.allowedIssueTypes.Task, "10010");
  assert.equal(config.slack.workspaceId, "T-EVERFIT");
  assert.equal(config.secrets.jiraApiToken, "secret");
  assert.equal(config.workflow.draftTtlMs, 86_400_000);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.jira));
  assert.ok(Object.isFrozen(config.jira.allowedIssueTypes));
});

test("rejects unsupported project and missing secrets", () => {
  assert.throws(
    () => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, projectKey: "OTHER" } }, secrets),
    /projectKey must be ED/,
  );
  assert.throws(() => parseJiraRuntimeConfig(valid, {}), /FRIDAY_JIRA_EMAIL/);
});

test("fails closed for invalid configuration boundaries", () => {
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, baseUrl: "http://everfit.atlassian.net" } }, secrets), /HTTPS/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, allowedIssueTypes: { Task: "10010", Bug: "10011" } } }, secrets), /allowedIssueTypes/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, allowedIssueTypes: { ...valid.jira.allowedIssueTypes, Epic: "10013" } } }, secrets), /allowedIssueTypes/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, epicJql: "project = ED" } }, secrets), /epicJql/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, maxEpicCandidates: 51 } }, secrets), /maxEpicCandidates/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, workflow: { ...valid.workflow, draftTtlMinutes: 4 } }, secrets), /draftTtlMinutes/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, workflow: { ...valid.workflow, maxCreateAttempts: 6 } }, secrets), /maxCreateAttempts/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, apiTokenEnv: "JIRA-TOKEN" } }, secrets), /environment variable name/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, slack: { accountId: "everfit", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN" } }, secrets), /slack/);
  assert.throws(() => parseJiraRuntimeConfig({ ...valid, slack: { ...valid.slack, workspaceId: "" } }, secrets), /workspaceId/);
});

test("does not disclose secret values in configuration errors", () => {
  const secret = "must-not-appear";
  assert.throws(
    () => parseJiraRuntimeConfig({ ...valid, jira: { ...valid.jira, baseUrl: "http://invalid" } }, { ...secrets, FRIDAY_EVERFIT_JIRA_API_TOKEN: secret }),
    (error: Error) => !error.message.includes(secret),
  );
});
