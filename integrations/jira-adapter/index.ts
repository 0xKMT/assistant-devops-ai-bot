/** OpenClaw registration for bounded Jira draft tools and Slack callbacks. */
import path from "node:path";
import type {
  JiraContextParams,
  JiraIssueType,
  JiraPrepareTicketToolParams,
} from "@friday/shared";
import { jiraContextSchema, jiraPrepareTicketSchema, toolResult } from "@friday/shared";
import type { OpenClawPluginApi, OpenClawPluginDefinition, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { openDraftStore, type DraftStore } from "./draft-store.js";
import { createInteractiveHandler } from "./interactive-handler.js";
import { createJiraClient } from "./jira-client.js";
import { parseJiraRuntimeConfig, type JiraRuntimeConfig } from "./runtime-config.js";
import { createSlackTicketUi, type SlackTicketUi } from "./slack-ticket-ui.js";
import { createTicketEngine, type TicketEngine } from "./ticket-engine.js";

export interface JiraAdapterFactories {
  readonly parseConfig: (value: unknown) => JiraRuntimeConfig;
  readonly openDraftStore: (databasePath: string) => DraftStore;
  readonly createJiraClient: typeof createJiraClient;
  readonly createSlackTicketUi: typeof createSlackTicketUi;
  readonly createTicketEngine: typeof createTicketEngine;
}

const productionFactories: JiraAdapterFactories = {
  parseConfig: parseJiraRuntimeConfig,
  openDraftStore,
  createJiraClient,
  createSlackTicketUi,
  createTicketEngine,
};

// OpenClaw creates one plugin registration for lifecycle hooks and another for
// lazy model tools. Runtime state must therefore live at module scope rather
// than in a single registration closure.
let engine: TicketEngine | undefined;
let slack: SlackTicketUi | undefined;
let store: DraftStore | undefined;
let activeAccountId: string | undefined;
let activeWorkspaceId: string | undefined;
const inboundSources = new Map<string, InboundSource>();

function unavailable(): never {
  throw new Error("Friday Jira Adapter is not ready.");
}

type InboundSource = JiraContextParams & { readonly sessionKey: string };

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slackTarget(value: unknown): string | undefined {
  const target = clean(value);
  return target
    ?.replace(/^(?:slack:)?(?:channel|chat):/, "")
    .replace(/:thread:.+$/, "")
    .toLowerCase();
}

/** Turns OpenClaw's delivery address into the raw Slack channel ID for Web API calls. */
function slackChannelId(value: unknown): string | undefined {
  return clean(value)
    ?.replace(/^(?:slack:)?(?:channel|chat):/, "")
    .replace(/:thread:.+$/, "");
}

/** Registers only model-safe tools; issue creation remains callback-only. */
export function registerWith(api: OpenClawPluginApi, factories: JiraAdapterFactories = productionFactories): void {
  const activeEngine: TicketEngine = {
    getContext: (source) => engine?.getContext(source) ?? unavailable(),
    prepare: (input) => engine?.prepare(input) ?? unavailable(),
    getRequesterDraft: (draftId, requesterUserId) => engine?.getRequesterDraft(draftId, requesterUserId) ?? unavailable(),
    edit: (request) => engine?.edit(request) ?? unavailable(),
    cancel: (draftId, requesterUserId) => engine?.cancel(draftId, requesterUserId) ?? unavailable(),
    approveAndCreate: (request) => engine?.approveAndCreate(request) ?? unavailable(),
    retryLinkPost: (draftId, requesterUserId) => engine?.retryLinkPost(draftId, requesterUserId) ?? unavailable(),
  };
  const activeSlack: SlackTicketUi = {
    postTicketPreview: (draft) => slack?.postTicketPreview(draft) ?? unavailable(),
    openTicketEditModal: (triggerId, draft, epics, priorities) => slack?.openTicketEditModal(triggerId, draft, epics, priorities) ?? unavailable(),
    postTicketLink: (channelId, threadTs, issueUrl) => slack?.postTicketLink(channelId, threadTs, issueUrl) ?? unavailable(),
    ticketLinkExists: (channelId, threadTs, issueUrl) => slack?.ticketLinkExists(channelId, threadTs, issueUrl) ?? unavailable(),
  };

  const sourceForTool = (context: OpenClawPluginToolContext): JiraContextParams | undefined => {
    const sessionKey = clean(context.sessionKey);
    const source = sessionKey ? inboundSources.get(sessionKey) : undefined;
    const delivery = context.deliveryContext;
    const threadId = delivery?.threadId === undefined ? undefined : String(delivery.threadId);
    // A root Slack message has no delivery thread ID in the pinned runtime;
    // its message timestamp is the canonical thread timestamp. Replies must
    // still provide the exact parent thread ID.
    const threadMatches = source
      && (source.threadTs === source.snapshotCutoffTs
        ? (threadId === undefined || threadId === source.threadTs)
        : threadId === source.threadTs);
    // OpenClaw 2026.7.1 omits accountId from both its observer hook and the
    // per-run tool context. This adapter is installed for one immutable Jira
    // Slack account, while Security Shield has already authorized the inbound
    // account/workspace/user tuple before an agent run may begin.
    const deliveryAccountId = clean(delivery?.accountId) ?? activeAccountId;
    const matches = Boolean(source
      && context.messageChannel === "slack"
      && clean(context.requesterSenderId) === source.requesterUserId
      && clean(delivery?.channel) === "slack"
      && deliveryAccountId === source.slackAccountId
      && slackTarget(delivery?.to) === slackTarget(source.slackChannelId)
      && threadMatches
      && activeWorkspaceId === source.slackWorkspaceId);
    if (!matches) {
      api.logger.info(`[friday-jira] source binding rejected source=${Boolean(source)} engine=${Boolean(engine)} session=${Boolean(sessionKey)} requester=${clean(context.requesterSenderId) === source?.requesterUserId} target=${slackTarget(delivery?.to) === source?.slackChannelId} thread=${Boolean(threadMatches)}`);
      return undefined;
    }
    if (!source
      || context.messageChannel !== "slack"
      || clean(context.requesterSenderId) !== source.requesterUserId
      || clean(delivery?.channel) !== "slack"
      || deliveryAccountId !== source.slackAccountId
      || slackTarget(delivery?.to) !== slackTarget(source.slackChannelId)
      || !threadMatches
      || activeWorkspaceId !== source.slackWorkspaceId) return undefined;
    const { sessionKey: _sessionKey, ...trusted } = source;
    return trusted;
  };

  api.registerTool(
    (context) => {
      const source = sourceForTool(context);
      return {
        name: "friday_jira_get_context",
        description: "Return bounded Everfit Devops Jira metadata and active Epic candidates for the current trusted Slack ticket source. This operation does not create Jira issues.",
        parameters: jiraContextSchema,
        async execute() {
          if (!source) unavailable();
          return toolResult(await activeEngine.getContext(source));
        },
      };
    },
    { name: "friday_jira_get_context", optional: true },
  );
  api.registerTool(
    (context) => {
      const source = sourceForTool(context);
      return {
        name: "friday_jira_prepare_ticket",
        description: "Validate and stage a requester-owned Jira ticket draft from the current trusted Slack thread, then send the requester a private review. Jira creation requires requester approval.",
        parameters: jiraPrepareTicketSchema,
        async execute(_id, params: JiraPrepareTicketToolParams) {
          if (!source) unavailable();
          const draft = await activeEngine.prepare({ ...params, ...source });
          return toolResult({ draftId: draft.id, version: draft.version, status: "Drafted" as const, reviewDelivery: "ephemeral" as const });
        },
      };
    },
    { name: "friday_jira_prepare_ticket", optional: true },
  );
  const interactiveHandler = createInteractiveHandler({
    engine: activeEngine,
    slack: activeSlack,
    log: (message) => api.logger.info(message),
  });
  api.registerInteractiveHandler({
    channel: "slack",
    namespace: "friday-jira",
    handler: (context) => {
      const workspaceId = context.workspaceId ?? activeWorkspaceId;
      return interactiveHandler(workspaceId ? { ...context, workspaceId } : context);
    },
  });

  const initialize = () => {
    if (engine) return;
    const config = factories.parseConfig(api.pluginConfig ?? api.config);
    const nextStore = factories.openDraftStore(path.join(api.runtime.state.resolveStateDir(), "friday-jira.sqlite"));
    try {
      const nextSlack = factories.createSlackTicketUi(config);
      const nextEngine = factories.createTicketEngine({
        draftStore: nextStore,
        jira: factories.createJiraClient(config),
        slack: nextSlack,
        config: {
          defaultPriorityId: config.jira.defaultPriorityId,
          draftTtlMs: config.workflow.draftTtlMs,
          maxCreateAttempts: config.workflow.maxCreateAttempts,
          allowedIssueTypes: Object.keys(config.jira.allowedIssueTypes) as JiraIssueType[],
        },
      });
      store = nextStore;
      slack = nextSlack;
      engine = nextEngine;
      activeAccountId = config.slack.accountId;
      activeWorkspaceId = config.slack.workspaceId;
      api.logger.info("[friday-jira] initialized");
    } catch (error) {
      nextStore.close();
      throw error;
    }
  };
  api.on("gateway_start", initialize);
  const captureInboundSource = (event: Record<string, unknown>, context: Record<string, unknown>) => {
    // The pinned runtime can register optional plugin tools before it invokes
    // gateway_start. Initialize on the first trusted inbound event as well,
    // so a ready gateway never exposes an inert Jira tool.
    initialize();
    const sessionKey = clean(event.sessionKey) ?? clean(context.sessionKey);
    const accountId = clean(event.accountId) ?? clean(context.accountId) ?? activeAccountId;
    const channelId = slackChannelId(event.conversationId) ?? slackChannelId(context.conversationId);
    const requesterUserId = clean(event.senderId) ?? clean(context.senderId);
    const snapshotCutoffTs = clean(event.messageId) ?? clean(context.messageId);
    const rawThread = event.threadId;
    const threadTs = rawThread === undefined ? snapshotCutoffTs : clean(String(rawThread));
    const accepted = Boolean(sessionKey && accountId && channelId && requesterUserId && snapshotCutoffTs && threadTs
      && accountId === activeAccountId && activeWorkspaceId);
    if (!accepted || !sessionKey || !accountId || !channelId || !requesterUserId || !snapshotCutoffTs || !threadTs || !activeWorkspaceId) return;
    inboundSources.set(sessionKey, {
      sessionKey,
      slackAccountId: accountId,
      slackWorkspaceId: activeWorkspaceId,
      slackChannelId: channelId,
      threadTs,
      requesterUserId,
      snapshotCutoffTs,
    });
    if (inboundSources.size > 1_000) inboundSources.delete(inboundSources.keys().next().value ?? "");
  };
  // `inbound_claim` is first-handler-wins and Codex may claim an authorized
  // message before this adapter observes it. `message_received` is an
  // observer hook emitted before agent execution, so it is the reliable source
  // of the trusted Slack binding used by our model-safe tool factories.
  api.on("message_received", captureInboundSource);
  api.on("inbound_claim", captureInboundSource);
  api.on("gateway_stop", () => {
    store?.close();
    store = undefined;
    slack = undefined;
    engine = undefined;
    activeAccountId = undefined;
    activeWorkspaceId = undefined;
    inboundSources.clear();
  });
}

const plugin: OpenClawPluginDefinition = {
  id: "friday-jira-adapter",
  name: "Friday Jira Adapter",
  description: "Bounded Jira context, private drafts, and requester-approved Slack ticket creation for Friday.",
  register: registerWith,
};

export default plugin;
