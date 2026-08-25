# Instance Configuration

Copy `instance.example.json` to `instance.json`, then replace every ID and
absolute path with values for the target machine. The real instance file is
ignored by Git and must not contain token values.

`slack.accounts[]` is required. Each record is one independently bound Slack
App and includes its account, workspace, channel, owner, and distinct
`botTokenEnv` / `appTokenEnv` names. These are environment-variable names, not
tokens. The instance generator writes only secret references into the OpenClaw
patch. Container Edition derives one Docker secret file pair from each account
ID: `slack-<accountId>-bot-token` and `slack-<accountId>-app-token`.

Use `channelId: "*"` when the configured owner may invoke that account's App in
any channel where it is invited. The wildcard applies only to the channel; the
account, workspace, and owner remain exact. Use a `C...` or `G...` ID for a
single-channel account.

`modelBackend.profile` accepts `codex` or `claude-code`. Codex requires an
`openai/*` model. Claude Code requires an `anthropic/*` model and an absolute
executable path in `modelBackend.command`. The `runtime` section pins the tested
Node.js and OpenClaw versions.

Keep `paths.openclawStateDir`, workspace, and cache distinct. Each repository
needs an `owner/repository` slug, local root, matching HTTPS GitHub remote URL,
and fixed base branch.

Validate before generating artifacts:

```bash
npm run prepare:instance:check -- --config config/instance.json
```
