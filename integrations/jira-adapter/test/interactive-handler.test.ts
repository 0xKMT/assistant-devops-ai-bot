import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JiraContextResult } from "@friday/shared";
import { openDraftStore, type DraftRecord } from "../draft-store.js";
import { createInteractiveHandler } from "../interactive-handler.js";
import type { JiraClient } from "../jira-client.js";
import type { SlackTicketUi } from "../slack-ticket-ui.js";
import { TicketWorkflowError, createTicketEngine, type TicketEngine } from "../ticket-engine.js";

const draft: DraftRecord = {
  id: "draft-1", version: 1, status: "Drafted", priorityId: "3", epicKey: "ED-12", expiresAt: 9_999,
  idempotencyKey: null, jiraIssueKey: null, jiraIssueUrl: null, failureCode: null, linkPostStatus: "pending",
  slackAccountId: "everfit", slackWorkspaceId: "T1", slackChannelId: "C1", threadTs: "1710000000.000100",
  requesterUserId: "U1", snapshotCutoffTs: "1710000001.000100", title: "Prepare Jira ticket", issueType: "Task",
  description: "Prepare an English Jira ticket from the Slack discussion.", references: [], missingFields: [],
};

const context: JiraContextResult = {
  project: { id: "10001", key: "ED", name: "Everfit Devops" },
  issueTypes: [{ id: "10010", name: "Task" }, { id: "10011", name: "Bug" }, { id: "10012", name: "Story" }],
  priorities: [{ id: "3", name: "Medium" }],
  epicCandidates: [{ key: "ED-12", summary: "Jira approval", description: "Approval workflow", labels: [], components: [] }],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function fixture() {
  const calls: string[] = [];
  const edits: unknown[] = [];
  const approvals: unknown[] = [];
  const retries: unknown[] = [];
  const responses: string[] = [];
  const modalCalls: unknown[][] = [];
  const engine: TicketEngine = {
    getContext: async () => { calls.push("getContext"); return context; },
    prepare: async () => draft,
    getRequesterDraft: () => { calls.push("getRequesterDraft"); return draft; },
    edit: async (request) => { edits.push(request); return { ...draft, version: 2, status: "Edited" }; },
    cancel: async () => { calls.push("cancel"); },
    approveAndCreate: async (request) => { approvals.push(request); return { issueKey: "ED-123", issueUrl: "https://everfit.atlassian.net/browse/ED-123" }; },
    retryLinkPost: async (draftId, requesterUserId) => { retries.push([draftId, requesterUserId]); },
  };
  const slack: SlackTicketUi = {
    postTicketPreview: async () => undefined,
    openTicketEditModal: async (...args) => { modalCalls.push(args); },
    postTicketLink: async () => undefined,
    ticketLinkExists: async () => false,
  };
  const handler = createInteractiveHandler({ engine, slack });
  const callback = (override: Record<string, unknown> = {}) => ({
    data: "approve:draft-1:1", senderId: "U1", accountId: "everfit", workspaceId: "T1", channelId: "C1", threadTs: "1710000000.000100",
    auth: { isAuthorizedSender: true },
    respond: { acknowledge: () => { calls.push("acknowledge"); }, ephemeral: (text: string) => { responses.push(text); } },
    ...override,
  });
  return { handler, engine, slack, calls, edits, approvals, retries, responses, modalCalls, callback };
}

test("acknowledges a recognized callback before reading the draft", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback());

  assert.deepEqual(result, { handled: true });
  assert.deepEqual(subject.calls.slice(0, 2), ["acknowledge", "getRequesterDraft"]);
  assert.equal(subject.approvals.length, 1);
});

test("rejects a callback whose sender is not the draft requester", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback({ senderId: "U2" }));

  assert.equal(result?.handled, true);
  assert.equal(subject.approvals.length, 0);
  assert.match(subject.responses[0] ?? "", /not authorized/i);
});

test("rejects a callback outside the draft Slack conversation privately", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback({ channelId: "C2" }));

  assert.equal(result?.handled, true);
  assert.equal(subject.approvals.length, 0);
  assert.match(subject.responses[0] ?? "", /not authorized/i);
});

test("uses identical private copy for missing, forbidden, and tuple-probing drafts", async () => {
  const copies: string[] = [];
  for (const code of ["DRAFT_NOT_FOUND", "DRAFT_REQUESTER_FORBIDDEN"] as const) {
    const subject = fixture();
    subject.engine.getRequesterDraft = () => { throw new TicketWorkflowError(code); };
    await subject.handler(subject.callback());
    copies.push(subject.responses[0] ?? "");
  }
  const tuple = fixture();
  await tuple.handler(tuple.callback({ channelId: "C-probe" }));
  copies.push(tuple.responses[0] ?? "");

  assert.ok(copies[0]);
  assert.deepEqual(copies, [copies[0], copies[0], copies[0]]);
  assert.match(copies[0] ?? "", /not authorized/i);
  assert.doesNotMatch(copies[0] ?? "", /not found|no longer|missing/i);
});

test("real store and engine keep missing, wrong-requester, and tuple-probe denials indistinguishable", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "friday-interactive-privacy-"));
  const store = openDraftStore(path.join(directory, "friday-jira.sqlite"));
  const copies: string[] = [];
  try {
    const persisted = store.create({
      slackAccountId: draft.slackAccountId,
      slackWorkspaceId: draft.slackWorkspaceId,
      slackChannelId: draft.slackChannelId,
      threadTs: draft.threadTs,
      requesterUserId: draft.requesterUserId,
      snapshotCutoffTs: draft.snapshotCutoffTs,
      title: draft.title,
      issueType: draft.issueType,
      description: draft.description,
      references: draft.references,
      missingFields: draft.missingFields,
      priorityId: draft.priorityId,
      epicKey: "ED-12",
    }, { now: 1_000, expiresAt: 61_000 });
    const jira: JiraClient = {
      getContext: async () => context,
      createIssue: async () => { throw new Error("not reached"); },
      findByCorrelationId: async () => null,
    };
    const slack: SlackTicketUi = {
      postTicketPreview: async () => undefined,
      openTicketEditModal: async () => undefined,
      postTicketLink: async () => undefined,
      ticketLinkExists: async () => false,
    };
    const engine = createTicketEngine({
      draftStore: store,
      jira,
      slack,
      config: { defaultPriorityId: "3", draftTtlMs: 60_000, maxCreateAttempts: 3, allowedIssueTypes: ["Task", "Bug", "Story"] },
      clock: () => 2_000,
      sleep: async () => undefined,
    });
    const handler = createInteractiveHandler({ engine, slack });
    const invoke = async (data: string, senderId: string, channelId: string) => {
      const responses: string[] = [];
      const result = await handler({
        data, senderId, accountId: "everfit", workspaceId: "T1", channelId, threadTs: "1710000000.000100",
        auth: { isAuthorizedSender: true },
        respond: { acknowledge() {}, ephemeral(text) { responses.push(text); } },
      });
      assert.deepEqual(result, { handled: true });
      copies.push(responses[0] ?? "");
    };

    await invoke("approve:missing-draft:1", "U1", "C1");
    await invoke(`approve:${persisted.id}:1`, "U2", "C1");
    await invoke(`approve:${persisted.id}:1`, "U1", "C-probe");

    assert.equal(copies.length, 3);
    assert.deepEqual(copies, [copies[0], copies[0], copies[0]]);
    assert.match(copies[0] ?? "", /not authorized/i);
    assert.doesNotMatch(copies[0] ?? "", /not found|no longer|missing/i);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires a trigger ID before opening an edit modal", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback({ data: "edit:draft-1:1", triggerId: undefined }));

  assert.equal(result?.handled, true);
  assert.equal(subject.modalCalls.length, 0);
  assert.match(subject.responses[0] ?? "", /open the edit form/i);
});

test("opens an edit modal with the current draft and allowed metadata", async () => {
  const subject = fixture();

  await subject.handler(subject.callback({ data: "edit:draft-1:1", triggerId: "trigger-1" }));

  assert.deepEqual(subject.modalCalls, [["trigger-1", draft, context.epicCandidates, context.priorities]]);
});

test("normalizes only the six editable modal fields before editing", async () => {
  const subject = fixture();
  const result = await subject.handler(subject.callback({
    data: undefined,
    view: {
      callbackId: "openclaw:friday-jira:edit",
      privateMetadata: JSON.stringify({ pluginInteractiveData: "friday-jira:edit", draftId: "draft-1", version: 1, userId: "U1", channelId: "C1" }),
      state: {
        title: { title: { value: "  Edited title  " } },
        issueType: { issueType: { selected_option: { value: "Bug" } } },
        description: { description: { value: "  Edited English description.  " } },
        storyPoints: { storyPoints: { value: " 5 " } },
        priority: { priority: { selected_option: { value: "2" } } },
        epic: { epic: { selected_option: { value: "no-epic" } } },
        ignored: { attack: { value: "must not reach the engine" } },
      },
    },
  }));

  assert.equal(result?.handled, true);
  assert.deepEqual(subject.edits, [{
    draftId: "draft-1", expectedVersion: 1, requesterUserId: "U1",
    patch: { title: "Edited title", issueType: "Bug", description: "Edited English description.", priorityId: "2", epicKey: null, storyPoints: "5" },
  }]);
});

test("does not apply a stale callback version", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback({ data: "cancel:draft-1:2" }));

  assert.equal(result?.handled, true);
  assert.equal(subject.calls.includes("cancel"), false);
  assert.match(subject.responses[0] ?? "", /changed/i);
});

test("cancels a current requester draft", async () => {
  const subject = fixture();

  await subject.handler(subject.callback({ data: "cancel:draft-1:1" }));

  assert.equal(subject.calls.includes("cancel"), true);
  assert.match(subject.responses[0] ?? "", /cancelled/i);
});

test("suppresses a concurrent duplicate approval callback", async () => {
  const subject = fixture();
  const approval = deferred<{ issueKey: string; issueUrl: string }>();
  subject.engine.approveAndCreate = async (request) => { subject.approvals.push(request); return approval.promise; };

  const first = subject.handler(subject.callback());
  const second = await subject.handler(subject.callback());
  approval.resolve({ issueKey: "ED-123", issueUrl: "https://everfit.atlassian.net/browse/ED-123" });
  await first;

  assert.equal(second?.handled, true);
  assert.equal(subject.approvals.length, 1);
  assert.match(subject.responses[0] ?? "", /already being processed/i);
});

test("retries ticket-link delivery only for the current requester draft", async () => {
  const subject = fixture();

  await subject.handler(subject.callback({ data: "retry-link:draft-1:1" }));

  assert.deepEqual(subject.retries, [["draft-1", "U1"]]);
});

test("returns private stable errors without upstream detail", async () => {
  const subject = fixture();
  subject.engine.approveAndCreate = async () => { throw new Error("upstream token redacted-private-secret"); };

  const result = await subject.handler(subject.callback());

  assert.equal(result?.handled, true);
  assert.match(subject.responses[0] ?? "", /could not complete/i);
  assert.equal((subject.responses[0] ?? "").includes("redacted-private-secret"), false);
});

test("handles malformed Jira modal submissions privately instead of falling through", async () => {
  const subject = fixture();

  const result = await subject.handler(subject.callback({
    data: undefined,
    view: { callbackId: "openclaw:friday-jira:edit", privateMetadata: "not-json", state: {} },
  }));

  assert.equal(result?.handled, true);
  assert.equal(subject.edits.length, 0);
  assert.match(subject.responses[0] ?? "", /could not complete/i);
});

test("acknowledges malformed namespace callbacks and never falls through", async () => {
  for (const override of [
    { data: undefined },
    { data: "approve:draft-1:not-a-version" },
    { data: undefined, actionId: "friday:jira:approve" },
  ]) {
    const subject = fixture();
    const result = await subject.handler(subject.callback(override));
    assert.deepEqual(result, { handled: true });
    assert.equal(subject.calls[0], "acknowledge");
    assert.equal(subject.approvals.length, 0);
    assert.match(subject.responses[0] ?? "", /could not complete/i);
  }
});
