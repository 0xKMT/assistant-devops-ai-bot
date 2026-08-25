# Integrations

Adapters connect Friday to its runtime and external systems:

- `@friday/git-adapter` is the read-only OpenClaw pull-request review plugin.
- `@friday/jira-adapter` is the bounded Everfit Devops Slack-to-Jira draft and
  requester-approved creation plugin; see its [operator guide](jira-adapter/README.md).
- `@friday/slack-recovery` is an optional macOS launchd watchdog.

An integration may consume contracts from `@friday/shared`, but it must not use
cross-workspace relative imports or call another integration directly.
