import assert from "node:assert/strict";
import test from "node:test";
import { dockerSecretStem, parseSlackAccounts, secretFileNames } from "../lib/slack-accounts.mjs";

const account = (overrides = {}) => ({
  accountId: "infra", accountName: "Friday Infra", workspaceId: "TINFRA001",
  channelId: "CINFRA001", userId: "UINFRA001",
  botTokenEnv: "FRIDAY_INFRA_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_INFRA_SLACK_APP_TOKEN",
  ...overrides,
});

test("parses two independent Slack accounts with deterministic secret files", () => {
  const accounts = parseSlackAccounts({ accounts: [account(), account({ accountId: "everfit", accountName: "Friday Everfit", workspaceId: "TEVERFIT1", channelId: "CEVERFIT1", userId: "UEVERFIT1", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_EVERFIT_SLACK_APP_TOKEN" })] });
  assert.equal(accounts.length, 2);
  assert.deepEqual(secretFileNames(accounts[1]), { bot: "slack-everfit-bot-token", app: "slack-everfit-app-token" });
});

test("preserves an explicit per-account channel wildcard", () => {
  const [wildcard, exact] = parseSlackAccounts({ accounts: [
    account({ channelId: "*" }),
    account({ accountId: "everfit", accountName: "Friday Everfit", workspaceId: "TEVERFIT1", channelId: "CEVERFIT1", userId: "UEVERFIT1", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_EVERFIT_SLACK_APP_TOKEN" }),
  ] });
  assert.equal(wildcard.channelId, "*");
  assert.equal(exact.channelId, "CEVERFIT1");
});

test("rejects account, workspace, environment, and Docker-secret collisions", () => {
  assert.throws(() => parseSlackAccounts({ accounts: [account(), account()] }), /Duplicate Slack account ID/);
  assert.throws(() => parseSlackAccounts({ accounts: [account(), account({ accountId: "other", botTokenEnv: "FRIDAY_OTHER_BOT", appTokenEnv: "FRIDAY_OTHER_APP" })] }), /Duplicate Slack workspace ID/);
  assert.throws(() => parseSlackAccounts({ accounts: [account(), account({ accountId: "other", workspaceId: "TOTHER001", channelId: "COTHER001", userId: "UOTHER001", botTokenEnv: "FRIDAY_INFRA_SLACK_BOT_TOKEN", appTokenEnv: "FRIDAY_OTHER_APP" })] }), /token environment variable/);
  assert.throws(() => parseSlackAccounts({ accounts: [account({ accountId: "a-b" }), account({ accountId: "a_b", workspaceId: "TOTHER001", channelId: "COTHER001", userId: "UOTHER001", botTokenEnv: "FRIDAY_OTHER_BOT", appTokenEnv: "FRIDAY_OTHER_APP" })] }), /Docker secret stem/);
  assert.equal(dockerSecretStem("A-B"), "a_b");
});
