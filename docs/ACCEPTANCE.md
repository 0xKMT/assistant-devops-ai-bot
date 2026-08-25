# Acceptance Checklist

Record the date, OpenClaw version, backend/model, and result for every item. Do
not skip negative tests.

## Host and Service

- `npm test` passes.
- `openclaw config validate` succeeds.
- `openclaw plugins doctor` reports no Friday or backend failure.
- `openclaw gateway status` is healthy.
- `openclaw channels status --deep` reports Slack connected.
- The model catalog contains the configured primary model.

For Container Edition, `npm run container:health` must pass and the gateway port
must bind only to `127.0.0.1` unless another reviewed security design says
otherwise.

## Authorization

- For every configured Slack account, its owner mentions that App in its bound
  channel and receives a response.
- The owner writes without mentioning Friday and no turn starts.
- Another user mentions Friday in the same channel or thread and gets no reply;
  no model or tool work runs.
- The owner mentions Friday in another channel and is denied or silent according
  to policy.
- A cross-workspace attempt that combines an account from one record with a
  channel, workspace, or owner from another record is silently denied.
- For each account configured with `channelId: "*"`, the owner can mention its
  App in a second invited channel; an uninvited channel must not deliver events
  to Slack, and another user remains silently denied.
- Direct messages to Friday are disabled.

## Review Behavior

- An allowlisted PR returns its objective, findings, evidence, and verdict.
- A PR outside the allowlist is rejected before clone or read.
- A local remote that differs from the configured HTTPS URL fails closed.
- A missing or failed scanner cannot produce a falsely safe verdict.
- A two-PR batch returns each PR once without mixing evidence.
- Friday cannot merge, comment on GitHub, deploy, run arbitrary shell commands,
  or mutate a cluster.

## Jira Ticket Workflow

Run these checks from an authorized Everfit Slack account against the configured
Everfit Devops destination. Record the Slack thread URL, result, and created
Jira key when applicable, but never a token or private draft text.

1. **Mention-only context:** the requester tags Friday in a thread without an
   explicit description. Confirm the private draft summarizes only the root and
   replies at or before the mention timestamp, is English, marks missing fields,
   and excludes jokes, unrelated chat, reactions, images, icons, and decorative
   emoji. Links/attachments appear only as references.
2. **Explicit-description context:** tag Friday with an explicit description
   that differs from the earlier thread. Confirm that description is primary and
   the bounded prior thread is supplemental. Add a reply after the mention and
   confirm it does not change the already prepared draft.
3. **Private review and editing:** only the tagged requester sees the ephemeral
   review. It identifies title, issue type, description, priority, numeric Story
   point estimate, Epic, and missing fields. Edit title, Task/Bug/Story,
   description, priority, Story point estimate (a positive integer or decimal),
   and Epic; save and confirm the latest private review changes. Project and
   assignee are not editable.
4. **Classification:** prepare representative faulty behavior, user-value, and
   operational requests. Confirm the initial types are Bug, Story, and Task
   respectively; uncertain work starts as Task. Confirm no type outside those
   three can be saved.
5. **Epic policy:** use a request with a high-confidence active ED Epic and
   confirm that existing Epic is preselected. Use an ambiguous request and
   confirm `No Epic` is selected. Confirm the requester can choose or clear an
   existing Epic but Friday offers no Epic creation.
6. **Approval boundary:** before approval, verify Jira has no new issue. Use
   **Approve & Create**, then confirm exactly one English ED Task/Bug/Story is created, assigned
   to Tri Pham, with Medium as the default unless edited. The source thread
   receives only the Jira ticket URL; draft details and errors stay private.
7. **Unauthorized and stale actions:** have another user invoke a copied or
   visible action, then use an expired trigger or stale review. Confirm no Jira
   write occurs and every failure message is private. The tagged user alone may
   view, edit, approve, cancel, or retry.
8. **Idempotency and restart:** double-click approval, replay the callback if
   test tooling allows it, and restart the gateway while a request is pending.
   Confirm duplicate delivery creates no duplicate issue. For an ambiguous
   create, confirm the operator retains `friday-jira.sqlite` and reconciliation
   occurs before any retry.
9. **Failed link post:** simulate or observe a Slack `chat.postMessage` failure
   after Jira creation. Confirm the same requester can retry link delivery
   without another Jira create, and the final public output contains only the
   Jira URL.

## Pass Gate

Mark the installation production-ready only when every item passes. Keep the
results, but never put tokens, sensitive prompts, or repository source into a
release package.

## Automated Verification

The offline regression gate is deterministic and uses local fake Jira and Slack
transports. Record the date and result for each command; a passing automated gate
does not replace the operator checks below.

```bash
npx tsx --test integrations/jira-adapter/test/security-integration.test.ts integrations/jira-adapter/test/runtime-compatibility.test.ts
npm ci
npm test
npm run build
git diff --check
git status --short
```

The gate drives the actual production-rendered **Approve & Create** action
through the real callback handler. It closes the SQLite store, reopens the same
database path, and constructs a new engine/handler before proving that a failed
public link post can be retried by the requester without creating a second Jira
issue or a duplicate successful public link. Negative cases also prove that
malformed button, select, `view_submission`, and `view_closed` callback kinds
cannot cross-dispatch, and that forged or contract-required missing workspace
identity fails closed.

Because the pinned Slack callback bundle does not include `workspaceId`, the
adapter's validated configuration now requires the exact Slack workspace ID and
the production registration supplies it to the callback handler. The handler
still rejects missing or mismatched identity, and an executable pinned-bundle
probe confirms mismatched app/team modal events are acknowledged and dropped
before plugin dispatch. The same probe confirms modal response methods are
no-ops, so successful modal edits do not depend on a private reply being
deliverable from that path.

Before release, an operator must still complete these checks in the configured
Slack/Jira sandbox and record the Slack thread URL, result, and Jira key where
applicable:

- Confirm a real pinned OpenClaw gateway routes button and `view_submission`
  callbacks to the Jira Adapter for the configured Slack account and workspace.
- Confirm only the tagging requester can view, edit, cancel, approve, or retry;
  copied controls and forged account/workspace/channel/thread callbacks disclose
  no draft detail and perform no Jira write.
- Confirm explicit mention text remains primary, eligible thread text through the
  mention timestamp is supplemental, later replies are excluded, and files or
  images remain reference-only.
- Confirm the final English Task/Bug/Story uses the configured ED project and
  assignee, defaults to Medium unless edited, and uses an existing active Epic
  or No Epic.
- Confirm duplicate delivery, gateway restart, ambiguous Jira creation, and a
  Slack link-post failure create no duplicate issue or public link; the eventual
  public thread message is exactly the Jira URL.
- Inspect retained runtime state and operator logs for unexpected raw transcripts,
  tokens, authorization headers, private draft content, or upstream response
  bodies before declaring the installation production-ready.
