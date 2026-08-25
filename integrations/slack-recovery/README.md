# Friday Slack recovery

This local recovery layer fixes the Slack Socket Mode wake/reconnect failure
without adding Slack scopes.

The provider change itself lives in `../../compat/slack/` as a guarded,
reproducible patch. This workspace contains only the optional macOS watchdog;
no compiled Slack vendor bundle is stored here.

## Reconnect behavior

Before every Socket Mode connection attempt, the Slack provider calls
`auth.test`, validates the bot/app identity, refreshes the mutable monitor
context, and only then marks the connection healthy. If DNS or Slack is not
ready after macOS wake, the existing exponential reconnect loop keeps retrying.

## Watchdog behavior

`ai.friday.slack-watchdog` runs every 60 seconds and reads only new gateway log
bytes. It restarts the gateway when it detects an empty Slack identity,
`missing_recipient_team_id`, or a failed boot identity that was not later
refreshed.

Safety controls:

- DNS gate: never restarts while `slack.com` cannot resolve.
- Cooldown: at least five minutes between restarts.
- Circuit breaker: at most two restarts per 30 minutes.
- No Slack tokens, API calls, new scopes, or infrastructure write access.
- State is stored locally in `~/.openclaw/state/friday-slack-watchdog.json`.

## TypeScript source

```bash
npm run check
```

The watchdog source is `friday-slack-watchdog.ts`. The deployable Node.js
artifact is generated at `dist/friday-slack-watchdog.mjs`. Render
`../../templates/launchd/ai.friday.slack-watchdog.plist.template` with absolute
paths for the target Mac. Updating the live launchd job remains a separate,
explicit deployment step.
