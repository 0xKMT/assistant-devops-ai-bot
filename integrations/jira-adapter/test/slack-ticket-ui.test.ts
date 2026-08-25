import assert from "node:assert/strict";
import test from "node:test";
import type { JiraEpicCandidate } from "@friday/shared";
import type { DraftRecord } from "../draft-store.js";
import { SlackTicketUiError, buildTicketEditView, buildTicketReviewBlocks, createSlackTicketUi } from "../slack-ticket-ui.js";
import { parseJiraRuntimeConfig } from "../runtime-config.js";

const config = parseJiraRuntimeConfig({
  jira: {
    baseUrl: "https://everfit.atlassian.net",
    emailEnv: "FRIDAY_JIRA_EMAIL",
    apiTokenEnv: "FRIDAY_EVERFIT_JIRA_API_TOKEN",
    projectId: "10001",
    projectKey: "ED",
    assigneeAccountId: "712020:tri",
    defaultPriorityId: "3",
    storyPointFieldId: "customfield_10028",
    allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" },
    epicJql: "project = ED AND issuetype = Epic AND statusCategory != Done",
    maxEpicCandidates: 25,
  },
  slack: { accountId: "everfit", workspaceId: "T-EVERFIT", botTokenEnv: "FRIDAY_EVERFIT_SLACK_BOT_TOKEN" },
  workflow: { draftTtlMinutes: 1440, maxCreateAttempts: 3 },
}, {
  FRIDAY_JIRA_EMAIL: "tri@example.com",
  FRIDAY_EVERFIT_JIRA_API_TOKEN: "jira-token-not-for-errors",
  FRIDAY_EVERFIT_SLACK_BOT_TOKEN: "redacted-slack-bot-token",
});

const draft: DraftRecord = {
  id: "draft-1",
  version: 2,
  status: "Drafted",
  priorityId: "3",
  epicKey: "ED-12",
  expiresAt: 1_800_000,
  idempotencyKey: null,
  jiraIssueKey: null,
  jiraIssueUrl: null,
  failureCode: null,
  linkPostStatus: "pending",
  slackAccountId: "everfit",
  slackWorkspaceId: "T1",
  slackChannelId: "C1",
  threadTs: "1710000000.000100",
  requesterUserId: "U1",
  snapshotCutoffTs: "1710000001.000100",
  title: "Create Jira ticket from Slack",
  issueType: "Task",
  description: "Create a requester-approved Jira ticket from this Slack thread.",
  references: [],
  missingFields: ["Acceptance criteria"],
};

const epics: readonly JiraEpicCandidate[] = [{
  key: "ED-12",
  summary: "Jira workflow",
  description: "Requester-approved ticket workflow",
  labels: ["triage"],
  components: ["Platform"],
}];
const priorities = [{ id: "3", name: "Medium" }, { id: "2", name: "High" }];

type SeenRequest = { url: string; method: string; headers: Headers; body: Record<string, unknown> };

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(response: Response, seen: SeenRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    });
    return response;
  }) as typeof fetch;
}

function streamingResponse(read: ReadableStreamDefaultReader<Uint8Array>["read"], cancel?: ReadableStreamDefaultReader<Uint8Array>["cancel"]): Response {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read,
        cancel: cancel ?? (async () => undefined),
        releaseLock() {},
      }),
    },
  } as unknown as Response;
}

function actionIds(blocks: unknown): string[] {
  return (blocks as Array<{ elements?: Array<{ action_id?: string }> }>).flatMap((block) =>
    block.elements?.map((element) => element.action_id ?? "") ?? [],
  );
}

test("posts requester-only review with opaque actions", async () => {
  const seen: SeenRequest[] = [];
  const ui = createSlackTicketUi(config, fakeFetch(json(200, { ok: true }), seen));

  assert.deepEqual(Object.keys(ui).sort(), ["openTicketEditModal", "postTicketLink", "postTicketPreview", "ticketLinkExists"]);
  await ui.postTicketPreview(draft);

  assert.match(seen[0]?.url ?? "", /\/api\/chat\.postEphemeral$/);
  assert.equal(seen[0]?.body.user, draft.requesterUserId);
  assert.equal(seen[0]?.body.channel, draft.slackChannelId);
  assert.equal(seen[0]?.body.thread_ts, draft.threadTs);
  assert.deepEqual(actionIds(seen[0]?.body.blocks), ["friday-jira:approve", "friday-jira:edit", "friday-jira:cancel"]);
  assert.equal(
    (seen[0]?.body.blocks as Array<{ elements?: Array<{ text?: { text?: string } }> }>)[3]?.elements?.[0]?.text?.text,
    "Approve & Create",
  );
  assert.deepEqual(
    (seen[0]?.body.blocks as Array<{ elements?: Array<{ value?: string }> }>)[3]?.elements?.map((element) => element.value),
    ["draft-1:2", "draft-1:2", "draft-1:2"],
  );
  assert.match(JSON.stringify(seen[0]?.body.blocks), /Acceptance criteria/);
  assert.equal(JSON.stringify(seen[0]?.body.blocks).includes(draft.requesterUserId), false);
});

test("builds a bounded review and No Epic edit option", () => {
  const veryLong = { ...draft, title: "T".repeat(1_000), description: "D".repeat(10_000), missingFields: [] };
  const review = JSON.stringify(buildTicketReviewBlocks(veryLong));
  const view = buildTicketEditView({ ...draft, epicKey: null }, epics, priorities);
  const epicBlock = view.blocks[5] as { element: { options: Array<{ value: string }>; initial_option: { value: string } } };

  assert.equal(review.includes("T".repeat(1_000)), false);
  assert.equal(review.includes("D".repeat(10_000)), false);
  assert.equal(epicBlock.element.options[0]?.value, "no-epic");
  assert.equal(epicBlock.element.initial_option.value, "no-epic");
});

test("rejects unsafe Slack select metadata and leaves valid option values unchanged", () => {
  const validKey = "ED-12";
  const validPriority = "3";
  const overlong = "x".repeat(76);
  const view = buildTicketEditView(draft, [
    ...epics,
    { ...epics[0]!, key: overlong },
  ], [
    ...priorities,
    { id: overlong, name: "Overlong" },
  ]);
  const priorityBlock = view.blocks[4] as { element: { options: Array<{ value: string }>; initial_option: { value: string } } };
  const epicBlock = view.blocks[5] as { element: { options: Array<{ value: string }>; initial_option: { value: string } } };

  assert.deepEqual(priorityBlock.element.options.map((option) => option.value), [validPriority, "2"]);
  assert.deepEqual(epicBlock.element.options.map((option) => option.value), ["no-epic", validKey]);
  assert.equal(priorityBlock.element.initial_option.value, validPriority);
  assert.equal(epicBlock.element.initial_option.value, validKey);
  assert.throws(
    () => buildTicketEditView({ ...draft, priorityId: overlong }, epics, priorities),
    (error: unknown) => error instanceof SlackTicketUiError && error.code === "SLACK_INPUT_INVALID",
  );
  assert.throws(
    () => buildTicketEditView({ ...draft, epicKey: overlong }, epics, priorities),
    (error: unknown) => error instanceof SlackTicketUiError && error.code === "SLACK_INPUT_INVALID",
  );
});

test("opens an English edit modal bound to requester and version", async () => {
  const seen: SeenRequest[] = [];
  const ui = createSlackTicketUi(config, fakeFetch(json(200, { ok: true }), seen));

  await ui.openTicketEditModal("trigger-1", draft, epics, priorities);

  assert.match(seen[0]?.url ?? "", /\/api\/views\.open$/);
  const view = seen[0]?.body.view as { callback_id: string; title: { text: string }; private_metadata: string; blocks: Array<{ block_id?: string }> };
  assert.equal(view.callback_id, "openclaw:friday-jira:edit");
  assert.equal(view.title.text, "Edit Jira ticket");
  assert.deepEqual(JSON.parse(view.private_metadata), {
    pluginInteractiveData: "friday-jira:edit:draft-1:2",
    draftId: draft.id,
    version: draft.version,
    userId: draft.requesterUserId,
    channelId: draft.slackChannelId,
  });
  assert.deepEqual(view.blocks.map((block) => block.block_id), ["title", "issueType", "description", "storyPoints", "priority", "epic"]);
  assert.match(JSON.stringify(view.blocks[3]), /Story point estimate \(optional\).*3 or 5/);
  assert.equal(JSON.stringify(view.blocks).includes(draft.requesterUserId), false);
});

test("posts only the validated Jira URL to the source thread", async () => {
  const seen: SeenRequest[] = [];
  const ui = createSlackTicketUi(config, fakeFetch(json(200, { ok: true }), seen));

  await ui.postTicketLink("C1", "1710000000.000100", "https://everfit.atlassian.net/browse/ED-123");

  assert.match(seen[0]?.url ?? "", /\/api\/chat\.postMessage$/);
  assert.equal(seen[0]?.body.text, "https://everfit.atlassian.net/browse/ED-123");
  assert.equal(seen[0]?.body.thread_ts, "1710000000.000100");
  assert.deepEqual(Object.keys(seen[0]?.body ?? {}).sort(), ["channel", "text", "thread_ts"]);
});

test("reconciles an exact Jira URL through bounded Slack thread history", async () => {
  const seen: string[] = [];
  const ui = createSlackTicketUi(config, (async (input) => {
    const url = String(input);
    seen.push(url);
    if (seen.length === 1) {
      return json(200, {
        ok: true,
        messages: [{ text: "unrelated" }],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      });
    }
    return json(200, {
      ok: true,
      messages: [{ text: "https://everfit.atlassian.net/browse/ED-123" }],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
  }) as typeof fetch);

  const exists = await (ui as typeof ui & { ticketLinkExists(channelId: string, threadTs: string, issueUrl: string): Promise<boolean> })
    .ticketLinkExists("C1", "1710000000.000100", "https://everfit.atlassian.net/browse/ED-123");

  assert.equal(exists, true);
  assert.equal(seen.length, 2);
  assert.match(seen[0] ?? "", /\/api\/conversations\.replies\?channel=C1&ts=1710000000\.000100&limit=100$/);
  assert.match(seen[1] ?? "", /cursor=page-2/);
});

test("rejects invalid ticket links before transport", async () => {
  const seen: SeenRequest[] = [];
  const ui = createSlackTicketUi(config, fakeFetch(json(200, { ok: true }), seen));

  await assert.rejects(
    ui.postTicketLink("C1", "1710000000.000100", "https://attacker.example/browse/ED-123"),
    (error: unknown) => error instanceof SlackTicketUiError && error.code === "SLACK_INPUT_INVALID",
  );
  await assert.rejects(
    ui.postTicketLink("C1", "1710000000.000100", "https://everfit.atlassian.net/browse/ED-123?x=1"),
    (error: unknown) => error instanceof SlackTicketUiError && error.code === "SLACK_INPUT_INVALID",
  );
  await assert.rejects(
    ui.postTicketLink("C1", "1710000000.000100", " https://everfit.atlassian.net/browse/ED-123"),
    (error: unknown) => error instanceof SlackTicketUiError && error.code === "SLACK_INPUT_INVALID",
  );
  assert.equal(seen.length, 0);
});

test("fails closed on Slack ok false without leaking secrets", async () => {
  const seen: SeenRequest[] = [];
  const ui = createSlackTicketUi(config, fakeFetch(json(200, { ok: false, error: "invalid_auth:redacted-slack-bot-token" }), seen));

  await assert.rejects(ui.postTicketPreview(draft), (error: unknown) => {
    assert.ok(error instanceof SlackTicketUiError);
    assert.equal(error.code, "SLACK_API_FAILED");
    assert.equal(error.message.includes("redacted-slack-bot-token"), false);
    return true;
  });
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer redacted-slack-bot-token");
});

test("normalizes Slack stream reader failures without leaking response content", async () => {
  const rawFailure = new Error("upstream response redacted-slack-bot-token");
  const ui = createSlackTicketUi(config, (async () => streamingResponse(async () => { throw rawFailure; })) as typeof fetch);

  await assert.rejects(ui.postTicketPreview(draft), (error: unknown) => {
    assert.ok(error instanceof SlackTicketUiError);
    assert.equal(error.code, "SLACK_RESPONSE_INVALID");
    assert.equal(error.message.includes("redacted-slack-bot-token"), false);
    return true;
  });
});

test("normalizes Slack stream cancellation failures without leaking response content", async () => {
  const rawFailure = new Error("upstream cancel redacted-slack-bot-token");
  const oversized = new Uint8Array(64 * 1024 + 1);
  const ui = createSlackTicketUi(config, (async () => streamingResponse(
    async () => ({ done: false, value: oversized }),
    async () => { throw rawFailure; },
  )) as typeof fetch);

  await assert.rejects(ui.postTicketPreview(draft), (error: unknown) => {
    assert.ok(error instanceof SlackTicketUiError);
    assert.equal(error.code, "SLACK_RESPONSE_INVALID");
    assert.equal(error.message.includes("redacted-slack-bot-token"), false);
    return true;
  });
});
