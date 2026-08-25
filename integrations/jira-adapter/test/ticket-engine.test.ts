import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JiraContextResult, JiraPrepareTicketParams } from "@friday/shared";
import { openDraftStore } from "../draft-store.js";
import { JiraClientError, type ApprovedIssueInput, type JiraClient } from "../jira-client.js";
import type { SlackTicketUi } from "../slack-ticket-ui.js";
import { TicketWorkflowError, createTicketEngine } from "../ticket-engine.js";

const jiraUrl = "https://everfit.atlassian.net/browse/ED-123";
const context: JiraContextResult = {
  project: { id: "10001", key: "ED", name: "Everfit Devops" },
  issueTypes: [
    { id: "10010", name: "Task" },
    { id: "10011", name: "Bug" },
    { id: "10012", name: "Story" },
  ],
  priorities: [{ id: "3", name: "Medium" }, { id: "2", name: "High" }],
  epicCandidates: [{ key: "ED-7", summary: "Release automation", description: "Automate release work", labels: [], components: [] }],
};

const sampleInput: JiraPrepareTicketParams = {
  slackAccountId: "everfit",
  slackWorkspaceId: "T1",
  slackChannelId: "C1",
  threadTs: "1710000000.000100",
  requesterUserId: "U1",
  snapshotCutoffTs: "1710000001.000100",
  title: "Create the release runbook",
  issueType: "Task",
  description: "Document the English release process for operators.",
  references: ["https://example.test/release"],
  missingFields: [],
  epicKey: "ED-7",
  epicConfidence: "high",
  epicEvidence: "The thread is about the release workflow.",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function fixture(options: {
  readonly create?: (input: ApprovedIssueInput) => Promise<{ key: string; url: string }>;
  readonly preview?: () => Promise<void>;
  readonly link?: () => Promise<void>;
  readonly linkExists?: () => Promise<boolean>;
  readonly clock?: () => number;
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "friday-ticket-engine-"));
  const store = openDraftStore(path.join(directory, "friday-jira.sqlite"));
  const createCalls: ApprovedIssueInput[] = [];
  const findCalls: string[] = [];
  const previewCalls: string[] = [];
  const linkCalls: Array<[string, string, string]> = [];
  const linkReconciliationCalls: Array<[string, string, string]> = [];
  const sleeps: number[] = [];
  const jira: JiraClient = {
    getContext: async () => context,
    createIssue: async (input) => {
      createCalls.push(input);
      return options.create ? options.create(input) : { key: "ED-123", url: jiraUrl };
    },
    findByCorrelationId: async (correlationId) => {
      findCalls.push(correlationId);
      return null;
    },
  };
  const slack = {
    postTicketPreview: async (draft) => {
      previewCalls.push(draft.id);
      return options.preview ? options.preview() : undefined;
    },
    openTicketEditModal: async () => undefined,
    postTicketLink: async (channelId, threadTs, url) => {
      linkCalls.push([channelId, threadTs, url]);
      return options.link ? options.link() : undefined;
    },
    ticketLinkExists: async (channelId: string, threadTs: string, url: string) => {
      linkReconciliationCalls.push([channelId, threadTs, url]);
      return options.linkExists ? options.linkExists() : false;
    },
  } as SlackTicketUi & { ticketLinkExists(channelId: string, threadTs: string, issueUrl: string): Promise<boolean> };
  const engine = createTicketEngine({
    draftStore: store,
    jira,
    slack,
    config: { defaultPriorityId: "3", draftTtlMs: 60_000, maxCreateAttempts: 3, allowedIssueTypes: ["Task", "Bug", "Story"] },
    clock: options.clock ?? (() => 1_000),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  return {
    engine, jira, slack, store, directory, createCalls, findCalls, previewCalls, linkCalls, linkReconciliationCalls, sleeps,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("preparation forces configured Medium priority and accepts only a retrieved high-confidence Epic", async () => {
  const subject = fixture();
  try {
    const { epicEvidence: _epicEvidence, ...inputWithoutEvidence } = sampleInput;
    const draft = await subject.engine.prepare(inputWithoutEvidence);
    assert.equal(draft.priorityId, "3");
    assert.equal(draft.epicKey, "ED-7");
    assert.equal(draft.status, "Drafted");
    assert.deepEqual(subject.previewCalls, [draft.id]);
  } finally { subject.close(); }
});

test("keeps the durable draft private when review delivery fails", async () => {
  const subject = fixture({ preview: async () => { throw new Error("Slack unavailable"); } });
  try {
    await assert.rejects(
      subject.engine.prepare(sampleInput),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "SLACK_DELIVERY_FAILED",
    );
    assert.equal(subject.createCalls.length, 0);
  } finally { subject.close(); }
});

test("creates only after requester approval and posts only the URL", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    assert.equal(subject.createCalls.length, 0);
    const result = await subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" });
    assert.equal(subject.createCalls.length, 1);
    assert.deepEqual(subject.linkCalls, [[draft.slackChannelId, draft.threadTs, jiraUrl]]);
    assert.deepEqual(result, { issueKey: "ED-123", issueUrl: jiraUrl });
  } finally { subject.close(); }
});

test("rejects a non-requester without disclosing the draft or creating an issue", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U2" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "DRAFT_REQUESTER_FORBIDDEN",
    );
    assert.equal(subject.createCalls.length, 0);
  } finally { subject.close(); }
});

test("rejects invalid edits before durable mutation", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.edit({ draftId: draft.id, expectedVersion: 1, requesterUserId: "U1", patch: { title: "   ", issueType: "Task", description: "Ready description", priorityId: "2", epicKey: null } }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "DRAFT_INVALID",
    );
    assert.equal(subject.store.get(draft.id)?.version, 1);
  } finally { subject.close(); }
});

test("repeated approval returns the recorded issue without a second Jira or Slack mutation", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    const first = await subject.engine.approveAndCreate(request);
    const second = await subject.engine.approveAndCreate(request);
    assert.deepEqual(second, first);
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.linkCalls.length, 1);
  } finally { subject.close(); }
});

test("reconciles an ambiguous timeout before retrying", async () => {
  const subject = fixture({ create: async () => { throw new TicketWorkflowError("JIRA_AMBIGUOUS", "private"); } });
  try {
    subject.jira.findByCorrelationId = async (correlationId) => {
      subject.findCalls.push(correlationId);
      return { key: "ED-123", url: jiraUrl };
    };
    const draft = await subject.engine.prepare(sampleInput);
    const result = await subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" });
    assert.deepEqual(result, { issueKey: "ED-123", issueUrl: jiraUrl });
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.findCalls.length, 1);
  } finally { subject.close(); }
});

test("never resubmits after an ambiguous Jira outcome when reconciliation misses", async () => {
  const subject = fixture({ create: async () => { throw new TicketWorkflowError("JIRA_AMBIGUOUS", "private"); } });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_AMBIGUOUS",
    );
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.findCalls.length, 3);
    assert.deepEqual(subject.sleeps, [1_000, 2_000]);
    assert.equal(subject.store.get(draft.id)?.status, "Failed");
  } finally { subject.close(); }
});

test("treats a production Jira network timeout as ambiguous and never retries create", async () => {
  const subject = fixture({ create: async () => { throw new JiraClientError("JIRA_NETWORK", true); } });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_AMBIGUOUS",
    );
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.findCalls.length, 3);
    assert.deepEqual(subject.sleeps, [1_000, 2_000]);
    assert.equal(subject.store.get(draft.id)?.failureCode, "JIRA_AMBIGUOUS");
  } finally { subject.close(); }
});

test("bounds transient retries and marks the draft failed", async () => {
  const subject = fixture({ create: async () => { throw new JiraClientError("JIRA_TRANSIENT", true); } });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_TRANSIENT",
    );
    assert.equal(subject.createCalls.length, 3);
    assert.deepEqual(subject.sleeps, [1_000, 2_000]);
    assert.equal(subject.store.get(draft.id)?.status, "Failed");
  } finally { subject.close(); }
});

test("polls a delayed correlation label after a sent 5xx and issues exactly one Jira POST", async () => {
  const sentFailure = new JiraClientError("JIRA_TRANSIENT", true, undefined, true);
  const subject = fixture({ create: async () => { throw sentFailure; } });
  try {
    let polls = 0;
    subject.jira.findByCorrelationId = async (correlationId) => {
      subject.findCalls.push(correlationId);
      polls += 1;
      return polls === 2 ? { key: "ED-123", url: jiraUrl } : null;
    };
    const draft = await subject.engine.prepare(sampleInput);

    const result = await subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" });

    assert.deepEqual(result, { issueKey: "ED-123", issueUrl: jiraUrl });
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.findCalls.length, 2);
    assert.deepEqual(subject.sleeps, [1_000]);
  } finally { subject.close(); }
});

test("does not recreate a Jira issue when Slack link delivery fails", async () => {
  const subject = fixture({ link: async () => { throw new Error("Slack unavailable"); } });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    await assert.rejects(subject.engine.approveAndCreate(request), (error: unknown) => error instanceof TicketWorkflowError && error.code === "SLACK_DELIVERY_FAILED");
    await subject.engine.retryLinkPost(draft.id, "U1").catch(() => undefined);
    await subject.engine.approveAndCreate(request).catch(() => undefined);
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.store.get(draft.id)?.status, "Created");
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posting");
  } finally { subject.close(); }
});

test("reconciles a crash-after-accept link across reopen without a duplicate public URL", async () => {
  let delivered = true;
  const subject = fixture({
    link: async () => { throw new Error("response lost after Slack accepted the URL"); },
    linkExists: async () => delivered,
  });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    await assert.rejects(subject.engine.approveAndCreate(request), (error: unknown) =>
      error instanceof TicketWorkflowError && error.code === "SLACK_DELIVERY_FAILED");
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posting");

    await subject.engine.approveAndCreate(request);

    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.linkCalls.length, 1);
    assert.equal(subject.linkReconciliationCalls.length, 1);
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posted");
    delivered = false;
  } finally { subject.close(); }
});

test("preserves ambiguous Slack delivery until requester reconciliation permits one resend", async () => {
  let postAttempts = 0;
  let reconciliation: "error" | "missing" = "error";
  const subject = fixture({
    link: async () => {
      postAttempts += 1;
      if (postAttempts === 1) throw new Error("ambiguous Slack network outcome");
    },
    linkExists: async () => {
      if (reconciliation === "error") throw new Error("Slack history unavailable");
      return false;
    },
  });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    await assert.rejects(subject.engine.approveAndCreate(request));
    await assert.rejects(subject.engine.approveAndCreate(request));
    assert.equal(postAttempts, 1);
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posting");

    reconciliation = "missing";
    await subject.engine.approveAndCreate(request);
    assert.equal(postAttempts, 2);
    assert.equal(subject.createCalls.length, 1);
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posted");
  } finally { subject.close(); }
});

test("two engines sharing a store claim retry-link delivery exactly once", async () => {
  const subject = fixture({ link: async () => { throw new Error("initial Slack failure"); } });
  const pendingPost = deferred<void>();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(
      subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "SLACK_DELIVERY_FAILED",
    );
    let retryPosts = 0;
    const retrySlack = {
      postTicketPreview: async () => undefined,
      openTicketEditModal: async () => undefined,
      postTicketLink: async () => { retryPosts += 1; await pendingPost.promise; },
      ticketLinkExists: async () => false,
    } as SlackTicketUi & { ticketLinkExists(channelId: string, threadTs: string, issueUrl: string): Promise<boolean> };
    const makeEngine = () => createTicketEngine({
      draftStore: subject.store,
      jira: subject.jira,
      slack: retrySlack,
      config: { defaultPriorityId: "3", draftTtlMs: 60_000, maxCreateAttempts: 3, allowedIssueTypes: ["Task", "Bug", "Story"] },
      clock: () => 2_000,
      sleep: async () => undefined,
    });
    const first = makeEngine().retryLinkPost(draft.id, "U1");
    await new Promise((resolve) => setImmediate(resolve));
    const second = makeEngine().retryLinkPost(draft.id, "U1");
    await second;
    assert.equal(retryPosts, 1);
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posting");
    pendingPost.resolve();
    await first;
    assert.equal(subject.store.get(draft.id)?.linkPostStatus, "posted");
    assert.equal(subject.createCalls.length, 1);
  } finally { subject.close(); }
});

test("concurrent duplicate approval does not make a second Jira request", async () => {
  const pending = deferred<{ key: string; url: string }>();
  const subject = fixture({ create: async () => pending.promise });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    const first = subject.engine.approveAndCreate(request);
    await new Promise((resolve) => setImmediate(resolve));
    const second = subject.engine.approveAndCreate(request);
    pending.resolve({ key: "ED-123", url: jiraUrl });
    await Promise.all([first, second]);
    assert.equal(subject.createCalls.length, 1);
  } finally { subject.close(); }
});

test("a second engine waits for durable creation instead of issuing another request", async () => {
  const pending = deferred<{ key: string; url: string }>();
  const subject = fixture({ create: async () => pending.promise });
  const waitForCreation = deferred<void>();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    const request = { draftId: draft.id, version: 1, requesterUserId: "U1" };
    const first = subject.engine.approveAndCreate(request);
    await new Promise((resolve) => setImmediate(resolve));
    const secondEngine = createTicketEngine({
      draftStore: subject.store,
      jira: subject.jira,
      slack: subject.slack,
      config: { defaultPriorityId: "3", draftTtlMs: 60_000, maxCreateAttempts: 3, allowedIssueTypes: ["Task", "Bug", "Story"] },
      clock: () => 1_000,
      sleep: async () => waitForCreation.promise,
    });
    const second = secondEngine.approveAndCreate(request);
    await new Promise((resolve) => setImmediate(resolve));
    pending.resolve({ key: "ED-123", url: jiraUrl });
    await first;
    waitForCreation.resolve();
    assert.deepEqual(await second, { issueKey: "ED-123", issueUrl: jiraUrl });
    assert.equal(subject.createCalls.length, 1);
  } finally { subject.close(); }
});

test("marks an unresolved recovered Creating draft as failed without another Jira create", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    subject.store.approve(draft.id, 1, "U1", 1_000);
    subject.store.transition(draft.id, "Approved", "Creating", "U1", 1_000);
    await assert.rejects(subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_AMBIGUOUS");
    assert.equal(subject.createCalls.length, 0);
    assert.equal(subject.store.get(draft.id)?.status, "Failed");
    assert.equal(subject.store.get(draft.id)?.failureCode, "JIRA_AMBIGUOUS");
  } finally { subject.close(); }
});

test("marks an unresolved ambiguous failed retry as failed without another Jira create", async () => {
  const subject = fixture();
  try {
    const draft = await subject.engine.prepare(sampleInput);
    subject.store.approve(draft.id, 1, "U1", 1_000);
    subject.store.transition(draft.id, "Approved", "Creating", "U1", 1_000);
    subject.store.markFailed(draft.id, "JIRA_NETWORK", 1_000);
    await assert.rejects(subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_AMBIGUOUS");
    assert.equal(subject.createCalls.length, 0);
    assert.equal(subject.store.get(draft.id)?.status, "Failed");
    assert.equal(subject.store.get(draft.id)?.failureCode, "JIRA_AMBIGUOUS");
  } finally { subject.close(); }
});

test("rejects stale approval versions, expired drafts, and cancelled drafts", async () => {
  let time = 1_000;
  const subject = fixture({ clock: () => time });
  try {
    const draft = await subject.engine.prepare(sampleInput);
    await assert.rejects(subject.engine.approveAndCreate({ draftId: draft.id, version: 2, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "DRAFT_STALE");
    time = 61_000;
    await assert.rejects(subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "DRAFT_EXPIRED");
    time = 1_000;
    const cancelled = await subject.engine.prepare(sampleInput);
    await subject.engine.cancel(cancelled.id, "U1");
    await assert.rejects(subject.engine.approveAndCreate({ draftId: cancelled.id, version: 1, requesterUserId: "U1" }),
      (error: unknown) => error instanceof TicketWorkflowError && error.code === "DRAFT_STATE_INVALID");
    assert.equal(subject.createCalls.length, 0);
  } finally { subject.close(); }
});

test("does not retry Jira authentication or authorization failures", async () => {
  for (const code of ["JIRA_AUTH", "JIRA_FORBIDDEN"] as const) {
    const subject = fixture({ create: async () => { throw new JiraClientError(code); } });
    try {
      const draft = await subject.engine.prepare(sampleInput);
      await assert.rejects(subject.engine.approveAndCreate({ draftId: draft.id, version: 1, requesterUserId: "U1" }),
        (error: unknown) => error instanceof TicketWorkflowError && error.code === "JIRA_FAILED");
      assert.equal(subject.createCalls.length, 1);
      assert.deepEqual(subject.sleeps, []);
    } finally { subject.close(); }
  }
});
