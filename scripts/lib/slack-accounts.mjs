function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function slackId(value, pattern, label) {
  const normalized = required(value, label);
  if (!pattern.test(normalized) || /^.[0]+$/.test(normalized)) throw new Error(`${label} is not a valid Slack ID.`);
  return normalized;
}

function envName(value, label) {
  const normalized = required(value, label);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) throw new Error(`${label} must be an environment variable name.`);
  return normalized;
}

// A channel wildcard is intentionally narrow: it delegates channel membership
// to Slack while Security Shield continues to verify the account, workspace,
// and owner on every incoming turn.
function channelId(value, label) {
  const normalized = required(value, label);
  if (normalized === "*") return normalized;
  return slackId(normalized, /^[CG][A-Z0-9]{6,}$/, label);
}

export function dockerSecretStem(accountId) {
  return String(accountId).toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export function secretFileNames(account) {
  return {
    bot: `slack-${account.accountId}-bot-token`,
    app: `slack-${account.accountId}-app-token`,
  };
}

export function parseSlackAccounts(value) {
  const accounts = value?.accounts;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("slack.accounts must contain at least one account.");
  const seen = new Map();
  const claim = (kind, key, label) => {
    if (seen.has(`${kind}\0${key}`)) throw new Error(`Duplicate Slack ${label}: ${key}`);
    seen.set(`${kind}\0${key}`, true);
  };
  return accounts.map((item, index) => {
    const prefix = `slack.accounts[${index}]`;
    const accountId = required(item?.accountId, `${prefix}.accountId`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(accountId)) throw new Error(`${prefix}.accountId is invalid.`);
    const account = {
      accountId,
      accountName: required(item?.accountName, `${prefix}.accountName`),
      workspaceId: slackId(item?.workspaceId, /^T[A-Z0-9]{6,}$/, `${prefix}.workspaceId`),
      channelId: channelId(item?.channelId, `${prefix}.channelId`),
      userId: slackId(item?.userId, /^[UW][A-Z0-9]{6,}$/, `${prefix}.userId`),
      botTokenEnv: envName(item?.botTokenEnv, `${prefix}.botTokenEnv`),
      appTokenEnv: envName(item?.appTokenEnv, `${prefix}.appTokenEnv`),
    };
    if (account.botTokenEnv === account.appTokenEnv) throw new Error(`${prefix} bot and app token environment variables must differ.`);
    claim("account", account.accountId, "account ID");
    claim("workspace", account.workspaceId, "workspace ID");
    claim("binding", [account.accountId, account.workspaceId, account.channelId, account.userId].join("\0"), "binding");
    claim("env", account.botTokenEnv, "token environment variable");
    claim("env", account.appTokenEnv, "token environment variable");
    claim("stem", dockerSecretStem(account.accountId), "Docker secret stem");
    return Object.freeze(account);
  });
}
