# Friday Jira Adapter

`@friday/jira-adapter` turns a Friday-tagged Slack thread into a
requester-approved Jira ticket for the current Everfit Devops instance. It is
not a generic Jira client and it is not a multi-workspace ticket router.

## What It Does

1. The tagged Slack user asks Friday for a Jira ticket in a thread.
2. An explicit description next to the mention is primary; otherwise Friday
   summarizes the root and replies through the mention timestamp. Thread text is
   supplemental when an explicit description exists.
3. Friday prepares English ticket text, keeps useful links/attachments as
   references, filters jokes/chat/reactions/images/icons/decorative emoji, and
   visibly identifies missing information instead of inventing it.
4. It proposes `Task`, `Bug`, or `Story` (`Task` if uncertain), starts at
   `Medium`, and selects an existing active ED Epic only for a high-confidence
   match. Otherwise it uses `No Epic`; it never creates an Epic.
5. The requester alone receives an ephemeral draft review and can edit title,
   type, description, priority, or Epic, cancel, or approve.
6. Approval creates exactly one Jira issue. The source Slack thread then gets
   only the Jira URL. All other workflow details and failures remain private.

The **Approve & Create** control performs the approval/create boundary. There
is no Jira write before it passes requester, conversation, version, expiry, and
field checks.

## Current Configuration

The root instance configuration has a required `jira` object. Use
`config/instance.example.json` or `config/instance.container.example.json` as
the schema source. The deployed plugin receives the same values split into its
`jira`, `slack`, and `workflow` configuration sections.

| Field | Required current behavior |
| --- | --- |
| `baseUrl` | HTTPS Jira origin for Everfit, no path/query/credentials |
| `emailEnv` / `apiTokenEnv` | Environment-variable names for Jira account email and API token |
| `projectId` / `projectKey` | Stable project ID and fixed `ED` key |
| `assigneeAccountId` | Stable Jira account ID for Tri Pham |
| `defaultPriorityId` | Stable ID for Medium |
| `storyPointFieldId` | Stable Jira custom-field ID for numeric Story point estimate |
| `allowedIssueTypes` | Exactly stable IDs for `Task`, `Bug`, and `Story` |
| `epicJql` / `maxEpicCandidates` | Bounded active-ED Epic query and 1--50 result limit |
| `slack.accountId` / `slack.workspaceId` | Exact pinned Slack account and configured workspace binding used for privileged callbacks |
| `draftTtlMinutes` / `maxCreateAttempts` | 5--10,080 minutes and 1--5 bounded attempts |

The repository example uses `FRIDAY_JIRA_API_TOKEN`. Set the name referenced by
`jira.apiTokenEnv` in the native gateway environment or place its value in
`container/secrets/jira-api-token` for Container Edition. Do not write the token
to JSON, documentation, shell history, a URL, logs, or source control.

Use Jira administration/API metadata with an existing authenticated operator
session to discover IDs. Capture only project, issue-type, priority, and account
IDs; do not log the authorization header or token. The adapter validates that
the configuration remains ED-specific and fails closed for missing/extra types,
unsupported JQL, invalid secret names, or unavailable secrets.

## Runtime Boundary

The only model-visible operations are:

- `friday_jira_get_context` — returns bounded ED metadata and active Epic
  candidates for a supplied Slack source.
- `friday_jira_prepare_ticket` — validates and stores a requester-owned draft,
  then sends its private review.

Neither creates Jira issues or exposes generic Jira, Slack, shell, or filesystem
access. Creation happens only in the deterministic `slack` / `friday-jira`
interactive callback. The internal Slack UI has exactly three outbound actions:
private preview, edit modal, and URL-only source-thread post.

State is stored in `<OpenClaw state directory>/friday-jira.sqlite`; it retains
structured draft data, references, Slack source IDs, version/status, correlation
key, created Jira URL, and link status. It does not retain raw Slack transcripts.
Keep this database for recovery. Never delete it as part of routine rollback.

## Safe Recovery

Duplicate buttons, duplicate callback delivery, and process restarts reuse the
same durable draft and idempotency key. If Jira accepts a create but the response
is ambiguous, Friday searches for the correlation label before any further
create; an unresolved ambiguous outcome is not blindly retried. If Jira creation
succeeds but posting the URL fails, retry the link from the requester workflow;
that retry must not issue another Jira create.

For Jira 400/401/403/429/5xx, expired interaction triggers, stale drafts, or
link-post failures, follow [Troubleshooting](../../docs/TROUBLESHOOTING.md).
For rollback, preserve `friday-jira.sqlite` and follow
[Rollback](../../docs/ROLLBACK.md).

## Future Multi-Workspace Work

The root configuration supports multiple Slack account bindings, but the current
Jira Adapter is deliberately one ED destination bound to the first configured
Slack account. It does not dynamically choose a Jira site/project from a Slack
workspace. Supporting more workspaces would need an explicit, validated mapping
of Slack account/workspace to Jira destination, stable IDs, secret references,
draft isolation, and acceptance coverage. Until that is implemented, run a
separate explicitly configured deployment instead of assuming additional Slack
accounts enable Jira routing.
