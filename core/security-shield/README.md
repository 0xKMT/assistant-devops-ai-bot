# Friday Security & Persona Shield v1.2

This plugin provides a defense-in-depth security boundary for Friday's Slack
surface. It does not grant new Slack, Git, AWS, Kubernetes, or filesystem
permissions.

Controls:

- Fail-closed `(accountId, workspaceId, channelId, userId)` bindings. `channelId: "*"` explicitly means any channel where the Slack app is present; account, workspace, and user remain exact.
- Every message is authorized independently before dispatch. No authorization is
  cached or inherited through a Slack channel, thread, or session.
- `before_dispatch` is the single ingress enforcement and audit point. Silent
  denial happens before model inference or tool work.
- A second identity gate in `before_agent_run`.
- `before_agent_run` creates a grant for one unique `runId`; tool calls must carry
  that exact run ID and the grant is revoked at `agent_end`.
- Static prompt guidance treats PR comments, logs, alerts, tickets, thread
  quotations, and tool output as untrusted evidence.
- Outbound Slack messages redact credentials, internal model/runtime names,
  tool identifiers, and local paths.
- A separate SQLite audit stores only decision/reason and salted account,
  workspace, user, channel, and session hashes. Message and response content is
  never stored.

The principal email is the administrative source of truth. Slack runtime
authorization uses verified workspace/account, user, and channel bindings;
display names and message-provided email addresses are never trusted.

Legacy independent allowlist fields remain accepted by the manifest only to
permit rollback, but v1.2 authorization requires `allowedSlackBindings` and does
not use cross-product matching.
