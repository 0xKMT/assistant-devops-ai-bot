import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { JiraContextResult } from "@friday/shared";
import type { DraftStore } from "../draft-store.js";
import type { DraftRecord } from "../draft-store.js";
import { registerWith } from "../index.js";
import type { JiraRuntimeConfig } from "../runtime-config.js";
import type { TicketEngine } from "../ticket-engine.js";

test("registers exactly two optional model tools and one Slack handler", () => {
  const tools: Array<{ name: string; optional?: boolean }> = [];
  const interactiveHandlers: Array<{ channel: string; namespace: string; handler: unknown }> = [];
  const fakeApi = {
    config: {}, pluginConfig: {}, runtime: { state: { resolveStateDir: () => "/tmp/friday-jira-test" } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool: (tool: { name?: string } | ((context: unknown) => unknown), options?: { name?: string; optional?: boolean }) => {
      const name = options?.name ?? (typeof tool === "function" ? undefined : tool.name);
      assert.ok(name);
      tools.push(options?.optional === undefined ? { name } : { name, optional: options.optional });
    },
    registerInteractiveHandler: (registration: { channel: string; namespace: string; handler: unknown }) => { interactiveHandlers.push(registration); },
    on() {},
  };

  registerWith(fakeApi as never);

  assert.deepEqual(tools.map((tool) => tool.name), ["friday_jira_get_context", "friday_jira_prepare_ticket"]);
  assert.deepEqual(tools.map((tool) => tool.optional), [true, true]);
  assert.deepEqual(interactiveHandlers.map((entry) => [entry.channel, entry.namespace]), [["slack", "friday-jira"]]);
  assert.equal(typeof interactiveHandlers[0]?.handler, "function");
});

test("packages the compiled Jira plugin as an OpenClaw extension", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    openclaw?: { extensions?: string[] };
    files?: string[];
  };

  assert.deepEqual(manifest.openclaw?.extensions, ["./dist/index.js"]);
  assert.ok(manifest.files?.includes("dist/index.js"));
});

test("builds the callback dependencies at gateway start and closes its draft store on stop", async () => {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const toolFactories: Array<(context: unknown) => { name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
  const context: JiraContextResult = {
    project: { id: "10001", key: "ED", name: "Everfit Devops" }, issueTypes: [], priorities: [], epicCandidates: [],
  };
  const engine: TicketEngine = {
    getContext: async () => context,
    prepare: async () => { throw new Error("not used"); },
    getRequesterDraft: () => { throw new Error("not used"); },
    edit: async () => { throw new Error("not used"); },
    cancel: async () => { throw new Error("not used"); },
    approveAndCreate: async () => { throw new Error("not used"); },
    retryLinkPost: async () => { throw new Error("not used"); },
  };
  let openedPath = "";
  let closed = false;
  const store = { close: () => { closed = true; } } as DraftStore;
  const config = {
    jira: { defaultPriorityId: "3", allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" } },
    slack: { accountId: "everfit", workspaceId: "T-EVERFIT" },
    workflow: { draftTtlMs: 60_000, maxCreateAttempts: 3 },
  } as JiraRuntimeConfig;
  const fakeApi = {
    config: {}, pluginConfig: {}, runtime: { state: { resolveStateDir: () => "/private/state" } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool: (tool: (context: unknown) => { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => { toolFactories.push(tool); },
    registerInteractiveHandler() {},
    on: (event: string, handler: (...args: unknown[]) => unknown) => { events.set(event, handler); },
  };

  registerWith(fakeApi as never, {
    parseConfig: () => config,
    openDraftStore: (databasePath) => { openedPath = databasePath; return store; },
    createJiraClient: (() => ({}) as never),
    createSlackTicketUi: (() => ({}) as never),
    createTicketEngine: (dependencies) => {
      assert.equal(dependencies.draftStore, store);
      assert.equal(dependencies.config.defaultPriorityId, "3");
      return engine;
    },
  });
  events.get("gateway_start")?.();
  const sessionKey = "agent:friday:slack:channel:C1:thread:1710000001.000100";
  events.get("message_received")?.({
    messageId: "1710000001.000100", senderId: "U1",
  }, {
    channelId: "slack", conversationId: "C1", sessionKey,
  });
  const toolContext = {
    sessionKey, messageChannel: "slack", requesterSenderId: "U1",
    deliveryContext: { channel: "slack", to: "C1" },
  };
  const tools = toolFactories.map((factory) => factory(toolContext));
  const result = await tools.find((tool) => tool.name === "friday_jira_get_context")?.execute("tool-1", {});
  events.get("gateway_stop")?.();

  assert.equal(openedPath, "/private/state/friday-jira.sqlite");
  assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(context) }], details: context });
  assert.equal(closed, true);
});

test("production registration supplies the configured workspace to pinned callbacks", async () => {
  const events = new Map<string, () => void>();
  let registeredHandler: ((context: never) => Promise<{ handled: true }>) | undefined;
  let approvals = 0;
  const draft = {
    id: "draft-1", version: 1, status: "Drafted", priorityId: "3", epicKey: null, expiresAt: 99_999,
    idempotencyKey: null, jiraIssueKey: null, jiraIssueUrl: null, failureCode: null, linkPostStatus: "pending",
    slackAccountId: "everfit", slackWorkspaceId: "T-EVERFIT", slackChannelId: "C-DEVOPS", threadTs: "1710000000.000100",
    requesterUserId: "U-REQUESTER", snapshotCutoffTs: "1710000001.000100", title: "Release", issueType: "Task",
    description: "Prepare the release.", references: [], missingFields: [],
  } satisfies DraftRecord;
  const engine: TicketEngine = {
    getContext: async () => ({ project: { id: "10001", key: "ED", name: "Everfit Devops" }, issueTypes: [], priorities: [], epicCandidates: [] }),
    prepare: async () => draft,
    getRequesterDraft: () => draft,
    edit: async () => draft,
    cancel: async () => undefined,
    approveAndCreate: async () => { approvals += 1; return { issueKey: "ED-1", issueUrl: "https://everfit.atlassian.net/browse/ED-1" }; },
    retryLinkPost: async () => undefined,
  };
  const store = { close() {} } as DraftStore;
  const config = {
    jira: { defaultPriorityId: "3", allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" } },
    slack: { accountId: "everfit", workspaceId: "T-EVERFIT" },
    workflow: { draftTtlMs: 60_000, maxCreateAttempts: 3 },
  } as JiraRuntimeConfig;
  const fakeApi = {
    config: {}, pluginConfig: {}, runtime: { state: { resolveStateDir: () => "/private/state" } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool() {},
    registerInteractiveHandler(registration: { handler: typeof registeredHandler }) { registeredHandler = registration.handler; },
    on(event: string, handler: () => void) { events.set(event, handler); },
  };
  registerWith(fakeApi as never, {
    parseConfig: () => config,
    openDraftStore: () => store,
    createJiraClient: (() => ({}) as never),
    createSlackTicketUi: (() => ({}) as never),
    createTicketEngine: () => engine,
  });
  events.get("gateway_start")?.();
  assert.ok(registeredHandler);
  await registeredHandler({
    channel: "slack", accountId: "everfit", conversationId: "C-DEVOPS", threadId: "1710000000.000100",
    senderId: "U-REQUESTER", auth: { isAuthorizedSender: true },
    interaction: { kind: "button", actionId: "friday-jira:approve", data: "friday-jira:approve:draft-1:1" },
    respond: { acknowledge() {}, reply() {} },
  } as never);
  assert.equal(approvals, 1);
  events.get("gateway_stop")?.();
});

test("model tools derive immutable Slack identity from the pinned inbound runtime context", async () => {
  const events = new Map<string, (...args: never[]) => unknown>();
  const toolRegistrations: unknown[] = [];
  let prepared: unknown;
  const trustedDraft = {
    id: "draft-trusted", version: 1, status: "Drafted", priorityId: "3", epicKey: null, expiresAt: 99_999,
    idempotencyKey: null, jiraIssueKey: null, jiraIssueUrl: null, failureCode: null, linkPostStatus: "pending",
    slackAccountId: "everfit", slackWorkspaceId: "T-EVERFIT", slackChannelId: "C-DEVOPS", threadTs: "1710000000.000100",
    requesterUserId: "U-REQUESTER", snapshotCutoffTs: "1710000001.000200", title: "Release", issueType: "Task",
    description: "Prepare the release.", references: [], missingFields: [],
  } satisfies DraftRecord;
  const engine: TicketEngine = {
    getContext: async () => ({ project: { id: "10001", key: "ED", name: "Everfit Devops" }, issueTypes: [], priorities: [], epicCandidates: [] }),
    prepare: async (input) => { prepared = input; return trustedDraft; },
    getRequesterDraft: () => trustedDraft,
    edit: async () => trustedDraft,
    cancel: async () => undefined,
    approveAndCreate: async () => ({ issueKey: "ED-1", issueUrl: "https://everfit.atlassian.net/browse/ED-1" }),
    retryLinkPost: async () => undefined,
  };
  const store = { close() {} } as DraftStore;
  const config = {
    jira: { defaultPriorityId: "3", allowedIssueTypes: { Task: "10010", Bug: "10011", Story: "10012" } },
    slack: { accountId: "everfit", workspaceId: "T-EVERFIT" },
    workflow: { draftTtlMs: 60_000, maxCreateAttempts: 3 },
  } as JiraRuntimeConfig;
  const fakeApi = {
    config: {}, pluginConfig: {}, runtime: { state: { resolveStateDir: () => "/private/state" } },
    logger: { info() {}, warn() {}, error() {} },
    registerTool(registration: unknown) { toolRegistrations.push(registration); },
    registerInteractiveHandler() {},
    on(event: string, handler: (...args: never[]) => unknown) { events.set(event, handler); },
  };
  registerWith(fakeApi as never, {
    parseConfig: () => config,
    openDraftStore: () => store,
    createJiraClient: (() => ({})) as never,
    createSlackTicketUi: (() => ({
      postTicketPreview: async () => undefined,
      openTicketEditModal: async () => undefined,
      postTicketLink: async () => undefined,
      ticketLinkExists: async () => false,
    })) as never,
    createTicketEngine: () => engine,
  });
  events.get("gateway_start")?.();
  const sessionKey = "agent:friday:slack:channel:C-DEVOPS:thread:1710000000.000100";
  const inbound = events.get("message_received");
  assert.ok(inbound, "Jira adapter must bind tools to the actual inbound Slack message before Codex can claim it");
  await inbound({
    messageId: "1710000001.000200", threadId: "1710000000.000100", senderId: "U-REQUESTER",
  } as never, {
    channelId: "slack", accountId: "everfit", conversationId: "channel:C-DEVOPS", sessionKey,
  } as never);

  const prepareFactory = toolRegistrations.find((registration) => typeof registration === "function") as
    ((context: unknown) => { name: string; execute(id: string, params: unknown): Promise<unknown> }) | undefined;
  assert.ok(prepareFactory, "Jira model tools must be registered through trusted tool factories");
  const tools = toolRegistrations
    .filter((registration): registration is (context: unknown) => { name: string; execute(id: string, params: unknown): Promise<unknown> } => typeof registration === "function")
    .map((factory) => factory({
      sessionKey,
      messageChannel: "slack",
      deliveryContext: { channel: "slack", accountId: "everfit", to: "channel:C-DEVOPS", threadId: "1710000000.000100" },
      requesterSenderId: "U-REQUESTER",
    }));
  const prepareTool = tools.find((tool) => tool.name === "friday_jira_prepare_ticket");
  assert.ok(prepareTool);
  await prepareTool.execute("tool-prepare", {
    title: "Prepare release", issueType: "Task", description: "Prepare the English release.", references: [], missingFields: [],
    slackAccountId: "attacker", slackWorkspaceId: "T-FORGED", slackChannelId: "C-FORGED",
    threadTs: "999.000", requesterUserId: "U-ATTACKER", snapshotCutoffTs: "999.001",
  });

  assert.deepEqual(prepared, {
    title: "Prepare release", issueType: "Task", description: "Prepare the English release.", references: [], missingFields: [],
    slackAccountId: "everfit", slackWorkspaceId: "T-EVERFIT", slackChannelId: "C-DEVOPS",
    threadTs: "1710000000.000100", requesterUserId: "U-REQUESTER", snapshotCutoffTs: "1710000001.000200",
  });
  events.get("gateway_stop")?.();
});
