/**
 * Deterministic source transformations for the two Slack 2026.7.1 runtime
 * compatibility gaps. Each transformation requires one exact upstream anchor;
 * the CLI additionally verifies whole-file hashes before and after mutation.
 */

const RUN_ID_ANCHOR = "\t\t\treplyOptions: {\n\t\t\t\tskillFilter: prepared.channelConfig?.skills,";
const RUN_ID_PATCHED = "\t\t\treplyOptions: {\n\t\t\t\trunId: globalThis.crypto.randomUUID(),\n\t\t\t\tskillFilter: prepared.channelConfig?.skills,";

const IDENTITY_INSERT_ANCHOR = "\tconst trackEvent = opts.setStatus ? () => {";
const IDENTITY_START_ANCHOR = "\t\t\twhile (!opts.abortSignal?.aborted) try {\n\t\t\t\tconst disconnect = await startSlackSocketAndWaitForDisconnect({";
const IDENTITY_START_PATCHED = "\t\t\twhile (!opts.abortSignal?.aborted) try {\n\t\t\t\tawait refreshSlackIdentity();\n\t\t\t\tconst disconnect = await startSlackSocketAndWaitForDisconnect({";

const IDENTITY_REFRESH_BLOCK = `\tconst refreshSlackIdentity = async () => {
\t\tconst auth = await app.client.auth.test();
\t\tconst refreshedAuthUserId = normalizeOptionalString(auth.user_id) ?? "";
\t\tconst refreshedBotId = normalizeOptionalString(auth.bot_id) ?? "";
\t\tconst refreshedBotUserId = refreshedBotId ? refreshedAuthUserId : "";
\t\tconst refreshedTeamId = normalizeOptionalString(auth.team_id) ?? "";
\t\tconst refreshedApiAppId = normalizeOptionalString(auth.api_app_id) ?? "";
\t\tif (!refreshedAuthUserId || !refreshedBotId || !refreshedTeamId) throw new Error("slack auth.test returned incomplete bot identity");
\t\tconst refreshedIdentityWarning = formatSlackBotTokenIdentityWarning({
\t\t\tauth,
\t\t\taccountId: account.accountId
\t\t});
\t\tif (refreshedIdentityWarning) runtime.log?.(warn(refreshedIdentityWarning));
\t\tif (refreshedApiAppId && expectedApiAppIdFromAppToken && refreshedApiAppId !== expectedApiAppIdFromAppToken) throw new Error(\`slack token mismatch: bot token api_app_id=\${refreshedApiAppId} but app token looks like api_app_id=\${expectedApiAppIdFromAppToken}\`);
\t\tbotUserId = refreshedBotUserId;
\t\tbotId = refreshedBotId;
\t\tteamId = refreshedTeamId;
\t\tapiAppId = refreshedApiAppId;
\t\tctx.botUserId = refreshedBotUserId;
\t\tctx.botId = refreshedBotId;
\t\tctx.teamId = refreshedTeamId;
\t\tctx.apiAppId = refreshedApiAppId;
\t\truntime.log?.(\`[\${account.accountId}] slack identity refreshed\`);
\t};
`;

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function replaceExactlyOnce(source, before, after, label) {
  const count = occurrences(source, before);
  if (count !== 1) throw new Error(`${label}: expected exactly one upstream anchor, found ${count}`);
  return source.replace(before, after);
}

export function patchRunIdPropagation(source) {
  if (source.includes(RUN_ID_PATCHED)) return { source, state: "already-patched" };
  return {
    source: replaceExactlyOnce(source, RUN_ID_ANCHOR, RUN_ID_PATCHED, "runId propagation"),
    state: "patched",
  };
}

export function patchIdentityRefresh(source) {
  const hasBlock = source.includes("\tconst refreshSlackIdentity = async () => {");
  const hasReconnectCall = source.includes(IDENTITY_START_PATCHED);
  if (hasBlock && hasReconnectCall) return { source, state: "already-patched" };
  if (hasBlock !== hasReconnectCall) throw new Error("identity refresh: partial patch detected");

  let next = replaceExactlyOnce(
    source,
    IDENTITY_INSERT_ANCHOR,
    `${IDENTITY_REFRESH_BLOCK}${IDENTITY_INSERT_ANCHOR}`,
    "identity refresh function",
  );
  next = replaceExactlyOnce(next, IDENTITY_START_ANCHOR, IDENTITY_START_PATCHED, "identity refresh reconnect hook");
  return { source: next, state: "patched" };
}
