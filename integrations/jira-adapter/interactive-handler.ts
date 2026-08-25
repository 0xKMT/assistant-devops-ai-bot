/** Deterministic, requester-bound Slack callbacks for the Jira approval workflow. */
import type { SlackInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import type { EditableDraftPatch, DraftRecord } from "./draft-store.js";
import { NO_EPIC_OPTION_VALUE, SlackTicketUiError, type SlackTicketUi } from "./slack-ticket-ui.js";
import { TicketWorkflowError, type TicketEngine } from "./ticket-engine.js";

type CallbackAction = "approve" | "edit" | "cancel" | "retry-link";

type ParsedButton = {
  readonly kind: "button";
  readonly action: CallbackAction;
  readonly draftId: string;
  readonly version: number;
};

type ParsedModal = {
  readonly kind: "modal";
  readonly draftId: string;
  readonly version: number;
  readonly userId: string;
  readonly patch: EditableDraftPatch;
};

export interface InteractiveHandlerDependencies {
  readonly engine: TicketEngine;
  readonly slack: SlackTicketUi;
  /** Safe operational telemetry only; never receives an upstream response body. */
  readonly log?: (message: string) => void;
}

export type JiraInteractiveHandler = (context: SlackInteractiveContext) => Promise<{ handled: true }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function parseVersion(value: string): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function parseButton(data: string | undefined, expectedActionId?: string, requireActionId = false): ParsedButton | null {
  if (typeof data !== "string") return null;
  const normalized = data.startsWith("friday-jira:") ? data.slice("friday-jira:".length) : data;
  const parts = normalized.split(":");
  if (parts.length !== 3) return null;
  const action = parts[0];
  const draftId = boundedString(parts[1], 200);
  const version = parts[2] ? parseVersion(parts[2]) : null;
  if ((action !== "approve" && action !== "edit" && action !== "cancel" && action !== "retry-link") || !draftId || version === null) return null;
  if ((requireActionId || expectedActionId !== undefined) && expectedActionId !== `friday-jira:${action}`) return null;
  return { kind: "button", action, draftId, version };
}

function stateValue(state: Record<string, unknown>, blockId: string, actionId: string): Record<string, unknown> | null {
  return record(record(state[blockId])?.[actionId]);
}

function textValue(state: Record<string, unknown>, blockId: string): string | null {
  const value = stateValue(state, blockId, blockId)?.value;
  return typeof value === "string" ? value.trim() : null;
}

function optionalTextValue(state: Record<string, unknown>, blockId: string): string | null {
  const value = stateValue(state, blockId, blockId)?.value;
  return typeof value === "string" ? value.trim() || null : null;
}

function optionValue(state: Record<string, unknown>, blockId: string): string | null {
  const selected = record(stateValue(state, blockId, blockId)?.selected_option);
  const value = selected?.value;
  return typeof value === "string" ? value.trim() : null;
}

function parseModal(context: SlackInteractiveContext): ParsedModal | null {
  if (context.interaction?.kind === "view_submission") {
    const data = context.interaction.data?.startsWith("friday-jira:")
      ? context.interaction.data.slice("friday-jira:".length)
      : context.interaction?.data;
    const parts = data?.split(":") ?? [];
    const draftId = boundedString(parts[1], 200);
    const version = parts[2] ? parseVersion(parts[2]) : null;
    const userId = boundedString(context.senderId, 200);
    if (parts[0] !== "edit" || !draftId || version === null || !userId) return null;
    const state = record(context.interaction.stateValues);
    if (!state) return null;
    const title = textValue(state, "title");
    const issueType = optionValue(state, "issueType");
    const description = textValue(state, "description");
    const storyPoints = optionalTextValue(state, "storyPoints");
    const priorityId = optionValue(state, "priority");
    const epic = optionValue(state, "epic");
    if (title === null || issueType === null || description === null || priorityId === null || epic === null) return null;
    return {
      kind: "modal", draftId, version, userId,
      patch: { title, issueType: issueType as EditableDraftPatch["issueType"], description, priorityId, epicKey: epic === NO_EPIC_OPTION_VALUE ? null : epic || null, storyPoints },
    };
  }
  if (context.view?.callbackId !== "openclaw:friday-jira:edit") return null;
  try {
    const metadata = record(JSON.parse(context.view.privateMetadata ?? ""));
    const draftId = boundedString(metadata?.draftId, 200);
    const rawVersion = metadata?.version;
    const version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : null;
    const userId = boundedString(metadata?.userId, 200);
    if (metadata?.pluginInteractiveData !== "friday-jira:edit" || !draftId || version === null || !userId) return null;
    const state = record(context.view.state);
    if (!state) return null;
    const title = textValue(state, "title");
    const issueType = optionValue(state, "issueType");
    const description = textValue(state, "description");
    const storyPoints = optionalTextValue(state, "storyPoints");
    const priorityId = optionValue(state, "priority");
    const epic = optionValue(state, "epic");
    if (title === null || issueType === null || description === null || priorityId === null || epic === null) return null;
    return {
      kind: "modal", draftId, version, userId,
      patch: { title, issueType: issueType as EditableDraftPatch["issueType"], description, priorityId, epicKey: epic === NO_EPIC_OPTION_VALUE ? null : epic || null, storyPoints },
    };
  } catch {
    return null;
  }
}

function sameConversation(context: SlackInteractiveContext, draft: DraftRecord): boolean {
  return context.accountId === draft.slackAccountId
    && context.workspaceId === draft.slackWorkspaceId
    && (context.conversationId ?? context.channelId) === draft.slackChannelId
    && (context.threadId ?? context.threadTs) === draft.threadTs;
}

function sameModalConversation(context: SlackInteractiveContext, draft: DraftRecord): boolean {
  return context.accountId === draft.slackAccountId
    && context.workspaceId === draft.slackWorkspaceId
    && (context.conversationId ?? context.channelId) === draft.slackChannelId;
}

function privateError(error: unknown): string {
  if (error instanceof TicketWorkflowError) {
    if (error.code === "DRAFT_NOT_FOUND" || error.code === "DRAFT_REQUESTER_FORBIDDEN") {
      return "You are not authorized to act on this Jira ticket draft.";
    }
    if (error.code === "DRAFT_STALE") return "This Jira ticket draft has changed. Please use its latest review.";
    if (error.code === "DRAFT_EXPIRED") return "This Jira ticket draft is no longer available.";
  }
  return "We could not complete that Jira ticket action. Please try again from the latest review.";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof TicketWorkflowError || error instanceof SlackTicketUiError) return error.code;
  return "UNEXPECTED";
}

async function acknowledge(context: SlackInteractiveContext): Promise<boolean> {
  try {
    await context.respond.acknowledge();
    return true;
  } catch {
    return false;
  }
}

async function respond(context: SlackInteractiveContext, text: string): Promise<void> {
  try {
    if (context.respond.ephemeral) await context.respond.ephemeral(text);
    else await context.respond.reply?.({ text, responseType: "ephemeral" });
  } catch {
    // Interactive callback delivery cannot safely retry a response.
  }
}

/** Creates a handler with all network and storage dependencies supplied by the caller. */
export function createInteractiveHandler(dependencies: InteractiveHandlerDependencies): JiraInteractiveHandler {
  const approvalsInFlight = new Set<string>();

  const requesterDraft = (context: SlackInteractiveContext, draftId: string, modal = false): DraftRecord | null => {
    if (!context.auth.isAuthorizedSender || !context.senderId) return null;
    const draft = dependencies.engine.getRequesterDraft(draftId, context.senderId);
    const conversationMatches = modal ? sameModalConversation(context, draft) : sameConversation(context, draft);
    if (draft.requesterUserId !== context.senderId || !conversationMatches) return null;
    return draft;
  };

  return async (context) => {
    let phase = "parse";
    const interaction = context.interaction;
    const kind = interaction?.kind;
    const hasLegacyView = context.view !== undefined;
    const hasLegacyButton = context.data !== undefined || context.actionId !== undefined;
    const ambiguousLegacyShape = kind === undefined && hasLegacyView && hasLegacyButton;
    const modal = kind === "view_submission" || (kind === undefined && hasLegacyView && !ambiguousLegacyShape) ? parseModal(context) : null;
    const button = kind === "button"
      ? parseButton(interaction?.data, interaction?.actionId, true)
      : kind === undefined && hasLegacyButton && !hasLegacyView ? parseButton(context.data, context.actionId) : null;
    if (!await acknowledge(context)) return { handled: true };

    try {
      if (!button && !modal) {
        const actionId = interaction?.actionId ?? context.actionId ?? "none";
        const data = interaction?.data ?? context.data;
        dependencies.log?.(`[friday-jira] interactive parse rejected kind=${kind ?? "legacy"} action=${actionId} dataLength=${typeof data === "string" ? data.length : 0}`);
        await respond(context, "We could not complete that Jira ticket action. Please try again from the latest review.");
        return { handled: true };
      }
      if (modal) {
        phase = "edit-draft";
        if (!context.auth.isAuthorizedSender || context.senderId !== modal.userId) {
          await respond(context, "You are not authorized to act on this Jira ticket draft.");
          return { handled: true };
        }
        const draft = requesterDraft(context, modal.draftId, true);
        if (!draft || draft.version !== modal.version) {
          await respond(context, draft ? "This Jira ticket draft has changed. Please use its latest review." : "You are not authorized to act on this Jira ticket draft.");
          return { handled: true };
        }
        await dependencies.engine.edit({
          draftId: modal.draftId, expectedVersion: modal.version, requesterUserId: modal.userId, patch: modal.patch,
        });
        await respond(context, "Your Jira ticket draft was updated for review.");
        return { handled: true };
      }

      if (!button) return { handled: true };
      const draft = requesterDraft(context, button.draftId);
      if (!draft) {
        await respond(context, "You are not authorized to act on this Jira ticket draft.");
        return { handled: true };
      }
      if (draft.version !== button.version) {
        await respond(context, "This Jira ticket draft has changed. Please use its latest review.");
        return { handled: true };
      }
      if (button.action === "edit") {
        phase = "open-edit-modal";
        const triggerId = context.interaction?.triggerId ?? context.triggerId;
        if (!triggerId) {
          await respond(context, "We could not open the edit form. Please use the latest Jira ticket review.");
          return { handled: true };
        }
        const metadata = await dependencies.engine.getContext(draft);
        await dependencies.slack.openTicketEditModal(triggerId, draft, metadata.epicCandidates, metadata.priorities);
        return { handled: true };
      }
      if (button.action === "cancel") {
        phase = "cancel-draft";
        await dependencies.engine.cancel(draft.id, draft.requesterUserId);
        await respond(context, "Your Jira ticket draft was cancelled.");
        return { handled: true };
      }
      if (button.action === "retry-link") {
        phase = "retry-link";
        await dependencies.engine.retryLinkPost(draft.id, draft.requesterUserId);
        await respond(context, "The Jira ticket link was posted to the Slack thread.");
        return { handled: true };
      }

      const key = `${draft.id}:${button.version}`;
      if (approvalsInFlight.has(key)) {
        await respond(context, "This Jira ticket approval is already being processed.");
        return { handled: true };
      }
      approvalsInFlight.add(key);
      try {
        phase = "approve-create";
        const created = await dependencies.engine.approveAndCreate({ draftId: draft.id, version: button.version, requesterUserId: draft.requesterUserId });
        await respond(context, `Your Jira ticket was created: ${created.issueUrl}`);
      } finally {
        approvalsInFlight.delete(key);
      }
      return { handled: true };
    } catch (error) {
      dependencies.log?.(`[friday-jira] interactive failure phase=${phase} code=${safeErrorCode(error)}`);
      await respond(context, privateError(error));
      return { handled: true };
    }
  };
}
