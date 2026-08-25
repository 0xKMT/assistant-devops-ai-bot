# Troubleshooting

## Preflight Reports the Wrong Node.js or OpenClaw Version

Use Node.js 24 in the same terminal that runs setup and install the exact
OpenClaw version pinned by configuration. Do not bypass a version check merely
to complete installation.

## Repository Validation Fails

Run `git -C <repo-path> remote get-url origin`. It must exactly equal the
configured `remoteUrl`; Friday requires a canonical HTTPS URL and does not
accept a similar URL or SSH alias automatically.

## Codex Has No Model

Run setup with `--login`, complete the OpenAI/ChatGPT flow, then check:

```bash
openclaw models list --provider openai
openclaw plugins doctor
```

Confirm that the account can use the selected model. Otherwise choose an
available `openai/*` model and run the generator again.

## Claude Code Is Not Logged In

Run `claude auth login`, then `claude auth status --text`. Confirm that
`modelBackend.command` is an existing executable absolute path, then run setup
with `--login` again.

## Slack Is Disconnected

Confirm Socket Mode, the app-level `connections:write` token, app installation,
channel invitation, and both secret variable names. For a daemon, secrets must
be in its service environment or state `.env`; exporting them in another
terminal is insufficient. After restart, run `openclaw channels status --deep`.

For Container Edition, confirm one non-empty pair of local files exists for each
configured account: `container/secrets/slack-<accountId>-bot-token` and
`container/secrets/slack-<accountId>-app-token`. Run the container dry-run again
after changing `slack.accounts[]`; it regenerates the ignored Compose secret
mapping without exposing token values.

`channelId: "*"` is valid only when the App should serve every channel where it
is invited. Use a real `C...` or `G...` ID when an account must remain limited to
one channel. The wildcard never widens the configured workspace or owner.

## A Valid Owner Does Not Receive a Reply

Compare account, workspace, channel, and user IDs rather than display names. The
message must mention the app in the configured channel. After a change, rerun
the generator, dry-run, apply, and validation.

## Another User Starts a Model or Tool Turn

Stop the gateway and roll back immediately. This is a security incident, not a
cosmetic defect. Verify that Security Shield is enabled, bindings are exact, and
`plugins doctor` is healthy before rerunning the negative test.

## Apply Fails Partway Through

Do not blindly repeat apply. Record the failing step, inspect the relevant
backup under `build/backups/`, run the rollback plan from
[Rollback](ROLLBACK.md), then correct the cause.

## Jira Fails Before a Draft Is Shown

Run `openclaw plugins doctor` and check that the configured Jira token
environment variable exists in the gateway process (or that
`container/secrets/jira-api-token` is non-empty in Container Edition). Verify
the fixed HTTPS base URL, Everfit Devops project ID/key `ED`, Tri Pham account
ID, Medium priority ID, and exactly Task/Bug/Story type IDs. Do not replace
stable IDs with display names.

- **400 or metadata failure:** an ID, allowed issue type, priority, or bounded
  active-ED Epic JQL is invalid for the current Jira project. Re-discover the
  stable IDs, update the instance configuration, dry-run, then apply.
- **401:** the API token or configured email is invalid or expired. Create or
  rotate the token through Jira, update the secret only, then re-run apply.
- **403:** the Jira identity lacks browse/create/assign permission in ED. Grant
  the required project permission; do not weaken Friday's project binding.
- **429:** Jira rate limited a metadata, search, or create request. Wait for the
  stated retry window and use the same requester draft. The adapter bounds
  retries and reconciles an approved create before any safe retry.
- **5xx or network timeout:** treat the create outcome as ambiguous. Do not
  click a new draft or manually re-create the issue. The stored idempotency
  label is reconciled first; if unresolved, retain `friday-jira.sqlite` and
  investigate privately.

Jira response bodies and credentials are intentionally not shown to Slack
users. Use local operator logs and Jira audit history with appropriate access;
do not paste secrets or private ticket content into a public Slack thread.

## Jira Review, Callback, or Link Problems

- **Expired trigger / edit form does not open:** Slack interaction trigger IDs
  are short-lived. Use the latest requester-only review and choose Edit again.
  Confirm Socket Mode, Interactivity, `chat:write`, and that the app was
  reinstalled after manifest changes.
- **Stale draft:** another edit changed the draft version, the draft expired, or
  the review was cancelled. Use the latest review; create a new request when
  the thread needs newer context.
- **A different user clicks a button:** Friday acknowledges the callback but
  keeps the response private and denies the action. Verify the exact Slack
  account/workspace/channel/thread/requester binding; never transfer a draft by
  forwarding its buttons.
- **Duplicate click, restart, or callback replay:** the durable draft and
  correlation label make the operation idempotent. Reuse the same requester
  review; do not create a second ticket request to compensate.
- **Jira issue exists but the source link was not posted:** this is a Slack
  delivery failure, not a reason to create again. The requester retries link
  posting from the private workflow. The public thread must contain only the
  validated Jira URL after a successful post.
