# Create the Friday Slack App

Friday uses Socket Mode, so a local gateway does not need a public HTTP endpoint.
For multiple workspaces, create one independent Slack App per workspace; one
Friday container may serve their baseline Slack/Git-review bindings. The current
Jira Adapter remains bound to its one configured Everfit account; see
[the Jira Adapter guide](../integrations/jira-adapter/README.md#future-multi-workspace-work).

## Create the App

1. Open the Slack API dashboard for one target workspace and select **Create New App → From an app manifest**.
2. Select the correct workspace and import `config/slack-app-manifest.json`.
3. Review scopes and events, then create the app.
4. Enable **Socket Mode**.
5. Create an app-level token with `connections:write`.
6. In **OAuth & Permissions**, install the app and obtain the bot token.
7. Invite the app to Friday's dedicated channel.
8. Repeat for every additional workspace. Do not reuse a bot or app token across
   workspaces.

The manifest contains scopes for App Home, mentions, threads, and permitted
channel history. If your organization requires fewer scopes, have the security
owner review and test a manifest variant; never add write or admin scopes by
default.

`chat:write` is required for both existing review replies and the Jira workflow:
the requester-only draft review uses `chat.postEphemeral`, the edit form uses
`views.open`, and a successful workflow uses `chat.postMessage` once to post the
Jira URL. No Jira draft content is posted publicly.

## Enable Jira Interactivity

The Jira workflow uses the same Friday app and Socket Mode connection. In the
Slack app dashboard, enable **Interactivity & Shortcuts** (the supplied manifest
sets `settings.interactivity.is_enabled` to true), then save changes and
**Reinstall to Workspace**. Reinstall after any manifest, scope, or
interactivity change; replace the bot token in the configured secret location if
Slack issues a new one.

There is no Request URL to configure: Slack sends Socket Mode callbacks for
buttons and modals to the OpenClaw gateway. Friday registers the
internal `slack` / `friday-jira` handler. The generated OpenClaw patch enables
`channels.slack.capabilities.interactiveReplies`; verify it after apply rather
than adding an HTTP callback endpoint.

Only the user who tagged Friday can receive the ephemeral Jira review or invoke
its buttons. The **Approve & Create** button performs the final create only
after requester and version checks.

## Obtain Exact IDs

- Workspace IDs begin with `T`.
- Public/private channel IDs begin with `C` or `G`.
- Owner user IDs begin with `U` or `W`.

Use Slack's **Copy link**, **View details**, or **Copy member ID** controls; do
not use display names. Put the IDs in one `slack.accounts[]` record per Slack
App. Each record has an exact account/workspace/owner binding. `channelId` may
be a specific `C...`/`G...` ID, or `"*"` for every channel where that App is
invited. A wildcard does not authorize other users or another workspace, and a
message cannot be authorized by mixing values from two records.

## Manage Secrets

For Container Edition, put each token pair in
`container/secrets/slack-<accountId>-bot-token` and
`container/secrets/slack-<accountId>-app-token`; their environment variable
names must match `botTokenEnv` and `appTokenEnv`. Never place token values in
JSON, shell history, a README, Git, or a source archive. Native setup can persist
them in the state `.env` with mode `0600` through `--write-env`.

## Verify

```bash
openclaw config validate
openclaw plugins doctor
openclaw channels status --deep
```

Then run the owner-positive and non-owner-negative checks in
[Acceptance](ACCEPTANCE.md).
