/** Requester-gated, durable orchestration for Friday's Slack-to-Jira tickets. */
import type { JiraContextParams, JiraContextResult, JiraPrepareTicketParams, JiraIssueType } from "@friday/shared";
import { type DraftRecord, type DraftStore, type EditableDraftPatch } from "./draft-store.js";
import { selectSuggestedEpic } from "./epic-matcher.js";
import { JiraClientError, type JiraClient } from "./jira-client.js";
import type { SlackTicketUi } from "./slack-ticket-ui.js";

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 16 * 1024;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const activeLinkPosts = new Set<string>();
const storyPointsValue = /^(?=.{1,16}$)(?:[1-9]\d*(?:\.\d+)?|0\.\d+)$/;

export type TicketWorkflowErrorCode =
  | "DRAFT_NOT_FOUND"
  | "DRAFT_REQUESTER_FORBIDDEN"
  | "DRAFT_INVALID"
  | "DRAFT_STALE"
  | "DRAFT_EXPIRED"
  | "DRAFT_STATE_INVALID"
  | "JIRA_AMBIGUOUS"
  | "JIRA_RATE_LIMITED"
  | "JIRA_TRANSIENT"
  | "JIRA_FAILED"
  | "SLACK_DELIVERY_FAILED";

/** Stable, private error for callbacks and model tools; it never carries upstream bodies. */
export class TicketWorkflowError extends Error {
  readonly code: TicketWorkflowErrorCode;

  constructor(code: TicketWorkflowErrorCode, _privateDetail?: string) {
    super(code);
    this.name = "TicketWorkflowError";
    this.code = code;
  }
}

export interface TicketEngineConfig {
  readonly defaultPriorityId: string;
  readonly draftTtlMs: number;
  readonly maxCreateAttempts: number;
  readonly allowedIssueTypes: readonly JiraIssueType[];
}

export interface TicketEngineDependencies {
  readonly draftStore: DraftStore;
  readonly jira: JiraClient;
  readonly slack: SlackTicketUi;
  readonly config: TicketEngineConfig;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface EditDraftRequest {
  readonly draftId: string;
  readonly expectedVersion: number;
  readonly requesterUserId: string;
  readonly patch: EditableDraftPatch;
}

export interface ApprovalRequest {
  readonly draftId: string;
  readonly version: number;
  readonly requesterUserId: string;
}

export interface TicketEngine {
  getContext(source: JiraContextParams): Promise<JiraContextResult>;
  prepare(input: JiraPrepareTicketParams): Promise<DraftRecord>;
  getRequesterDraft(draftId: string, requesterUserId: string): DraftRecord;
  edit(request: EditDraftRequest): Promise<DraftRecord>;
  cancel(draftId: string, requesterUserId: string): Promise<void>;
  approveAndCreate(request: ApprovalRequest): Promise<{ issueKey: string; issueUrl: string }>;
  retryLinkPost(draftId: string, requesterUserId: string): Promise<void>;
}

function invalid(): never {
  throw new TicketWorkflowError("DRAFT_INVALID");
}

function nonblankEnglishReady(value: string, maximum: number): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    && /[A-Za-z]/.test(value);
}

function sourceIsUsable(source: JiraContextParams): boolean {
  return [
    source.slackAccountId, source.slackWorkspaceId, source.slackChannelId,
    source.threadTs, source.requesterUserId, source.snapshotCutoffTs,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

function draftResult(draft: DraftRecord): { issueKey: string; issueUrl: string } {
  if (!draft.jiraIssueKey || !draft.jiraIssueUrl) throw new TicketWorkflowError("DRAFT_STATE_INVALID");
  return { issueKey: draft.jiraIssueKey, issueUrl: draft.jiraIssueUrl };
}

function storeError(error: unknown): TicketWorkflowError {
  const message = error instanceof Error ? error.message : "";
  if (/not found/i.test(message)) return new TicketWorkflowError("DRAFT_NOT_FOUND");
  if (/requester/i.test(message)) return new TicketWorkflowError("DRAFT_REQUESTER_FORBIDDEN");
  if (/expired/i.test(message)) return new TicketWorkflowError("DRAFT_EXPIRED");
  if (/stale.*version/i.test(message)) return new TicketWorkflowError("DRAFT_STALE");
  return new TicketWorkflowError("DRAFT_STATE_INVALID");
}

function jiraError(error: unknown): TicketWorkflowError {
  if (error instanceof TicketWorkflowError) return error;
  if (error instanceof JiraClientError) {
    if (error.code === "JIRA_RATE_LIMITED") return new TicketWorkflowError("JIRA_RATE_LIMITED");
    if (error.code === "JIRA_TRANSIENT" || error.code === "JIRA_NETWORK") return new TicketWorkflowError("JIRA_TRANSIENT");
    if (error.code === "JIRA_RECONCILIATION_AMBIGUOUS") return new TicketWorkflowError("JIRA_AMBIGUOUS");
  }
  return new TicketWorkflowError("JIRA_FAILED");
}

function retryable(error: unknown): boolean {
  return error instanceof TicketWorkflowError && (
    error.code === "JIRA_RATE_LIMITED" || error.code === "JIRA_TRANSIENT"
  );
}

function networkOutcome(error: unknown): boolean {
  return error instanceof JiraClientError && error.code === "JIRA_NETWORK";
}

function sentCreateOutcome(error: unknown): boolean {
  return error instanceof JiraClientError && error.createRequestSent;
}

function retryDelay(error: unknown, retryNumber: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** retryNumber);
  const retryAfter = error instanceof JiraClientError && error.retryAfterMs !== undefined ? error.retryAfterMs : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfter));
}

/** Creates a deterministic workflow. Its injected clock and sleep make expiry and retries testable. */
export function createTicketEngine(dependencies: TicketEngineDependencies): TicketEngine {
  if (!Number.isInteger(dependencies.config.maxCreateAttempts)
    || dependencies.config.maxCreateAttempts < 1
    || dependencies.config.maxCreateAttempts > 5) {
    throw new TicketWorkflowError("DRAFT_INVALID");
  }
  const now = dependencies.clock ?? Date.now;
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const inFlight = new Map<string, Promise<{ issueKey: string; issueUrl: string }>>();
  // Slack trigger IDs expire quickly. Keep the bounded metadata captured while
  // staging a draft so its Edit modal can be opened without another Jira call.
  const draftContexts = new Map<string, JiraContextResult>();

  const requesterDraft = (draftId: string, requesterUserId: string): DraftRecord => {
    try {
      const draft = dependencies.draftStore.get(draftId);
      if (!draft) throw new Error("draft not found");
      if (draft.requesterUserId !== requesterUserId) throw new Error("draft requester mismatch");
      return draft;
    } catch (error) {
      throw storeError(error);
    }
  };

  const validatePatch = (patch: EditableDraftPatch, context: JiraContextResult): void => {
    if (!nonblankEnglishReady(patch.title, MAX_TITLE_LENGTH) || !nonblankEnglishReady(patch.description, MAX_DESCRIPTION_LENGTH)) invalid();
    if (patch.storyPoints !== undefined && patch.storyPoints !== null && !storyPointsValue.test(patch.storyPoints)) invalid();
    if (!dependencies.config.allowedIssueTypes.includes(patch.issueType)
      || !context.issueTypes.some((type) => type.name === patch.issueType)
      || !context.priorities.some((priority) => priority.id === patch.priorityId)
      || (patch.epicKey !== null && !context.epicCandidates.some((epic) => epic.key === patch.epicKey))) invalid();
  };

  const deliverTicketLink = async (draft: DraftRecord): Promise<void> => {
    const result = draftResult(draft);
    if (activeLinkPosts.has(draft.id)) return;
    let current = dependencies.draftStore.get(draft.id) ?? draft;
    if (current.linkPostStatus === "posted") return;
    if (current.linkPostStatus === "posting") {
      activeLinkPosts.add(draft.id);
      try {
        const exists = await dependencies.slack.ticketLinkExists(current.slackChannelId, current.threadTs, result.issueUrl);
        if (exists) {
          dependencies.draftStore.markLinkPosted(current.id, current.requesterUserId, now());
          return;
        }
        current = dependencies.draftStore.resetLinkPost(current.id, current.requesterUserId, now());
      } catch {
        throw new TicketWorkflowError("SLACK_DELIVERY_FAILED");
      } finally {
        activeLinkPosts.delete(draft.id);
      }
    }
    let claimed: DraftRecord;
    try {
      const claim = dependencies.draftStore.claimLinkPost(draft.id, draft.requesterUserId, now());
      if (!claim.claimed) return;
      claimed = claim.draft;
    } catch (error) {
      throw storeError(error);
    }
    activeLinkPosts.add(draft.id);
    try {
      await dependencies.slack.postTicketLink(claimed.slackChannelId, claimed.threadTs, result.issueUrl);
    } catch {
      throw new TicketWorkflowError("SLACK_DELIVERY_FAILED");
    } finally {
      activeLinkPosts.delete(draft.id);
    }
    try {
      dependencies.draftStore.markLinkPosted(claimed.id, claimed.requesterUserId, now());
    } catch (error) {
      throw storeError(error);
    }
  };

  const persistAndDeliver = async (draft: DraftRecord, created: { key: string; url: string }): Promise<{ issueKey: string; issueUrl: string }> => {
    let persisted: DraftRecord;
    try {
      persisted = dependencies.draftStore.markCreated(draft.id, created.key, created.url, now());
    } catch (error) {
      throw storeError(error);
    }
    const result = draftResult(persisted);
    await deliverTicketLink(persisted);
    return result;
  };

  const reconcile = async (draft: DraftRecord): Promise<{ issueKey: string; issueUrl: string } | null> => {
    if (!draft.idempotencyKey) throw new TicketWorkflowError("DRAFT_STATE_INVALID");
    try {
      const found = await dependencies.jira.findByCorrelationId(draft.idempotencyKey);
      return found ? persistAndDeliver(draft, found) : null;
    } catch (error) {
      throw jiraError(error);
    }
  };

  /** Polls durable state and Jira reconciliation without ever issuing a create. */
  const reconcileUntilResolved = async (draft: DraftRecord): Promise<{ issueKey: string; issueUrl: string } | null> => {
    for (let attempt = 0; attempt < dependencies.config.maxCreateAttempts; attempt += 1) {
      const current = dependencies.draftStore.get(draft.id);
      if (current?.status === "Created") return draftResult(current);
      try {
        const found = await reconcile(draft);
        if (found) return found;
      } catch (error) {
        if (error instanceof TicketWorkflowError && !error.code.startsWith("JIRA_")) throw error;
        // The prior create outcome remains ambiguous even if a reconciliation
        // request is unavailable. Continue only within the configured bound.
      }
      const afterReconciliation = dependencies.draftStore.get(draft.id);
      if (afterReconciliation?.status === "Created") return draftResult(afterReconciliation);
      if (attempt + 1 < dependencies.config.maxCreateAttempts) await sleep(retryDelay(undefined, attempt));
    }
    const final = dependencies.draftStore.get(draft.id);
    return final?.status === "Created" ? draftResult(final) : null;
  };

  /** Finalizes an unresolved Creating record without clobbering a concurrent Jira success. */
  const markFailedOrReturnCreated = (draft: DraftRecord, failureCode: string): { issueKey: string; issueUrl: string } | null => {
    try {
      dependencies.draftStore.markFailed(draft.id, failureCode, now());
      return null;
    } catch (error) {
      const current = dependencies.draftStore.get(draft.id);
      if (current?.status === "Created") return draftResult(current);
      throw storeError(error);
    }
  };

  const createFromCreating = (draft: DraftRecord, reconcileFirst: boolean): Promise<{ issueKey: string; issueUrl: string }> => {
    const existing = inFlight.get(draft.id);
    if (existing) return existing;
    const work = (async () => {
      if (!draft.idempotencyKey) throw new TicketWorkflowError("DRAFT_STATE_INVALID");
      if (reconcileFirst) {
        const existingIssue = await reconcileUntilResolved(draft);
        if (existingIssue) return existingIssue;
        // A recovered Creating record may represent a process that timed out
        // after Jira accepted the request. A search miss is never evidence that
        // no issue exists, so do not submit another create from this state.
        const completedDuringFinalization = markFailedOrReturnCreated(draft, "JIRA_AMBIGUOUS");
        if (completedDuringFinalization) return completedDuringFinalization;
        throw new TicketWorkflowError("JIRA_AMBIGUOUS");
      }
      let lastError: TicketWorkflowError = new TicketWorkflowError("JIRA_FAILED");
      for (let attempt = 0; attempt < dependencies.config.maxCreateAttempts; attempt += 1) {
        try {
          const created = await dependencies.jira.createIssue({
            title: draft.title,
            issueType: draft.issueType,
            description: draft.description,
            priorityId: draft.priorityId,
            epicKey: draft.epicKey,
            storyPoints: draft.storyPoints ?? null,
            correlationId: draft.idempotencyKey,
          });
          return persistAndDeliver(draft, created);
        } catch (error) {
          const classified = jiraError(error);
          lastError = classified;
          if (sentCreateOutcome(error) || networkOutcome(error) || classified.code === "JIRA_AMBIGUOUS") {
            const resolved = await reconcileUntilResolved(draft);
            if (resolved) return resolved;
            lastError = new TicketWorkflowError("JIRA_AMBIGUOUS");
            break;
          }
          if (!retryable(classified)) break;
          let reconciled: { issueKey: string; issueUrl: string } | null;
          try {
            reconciled = await reconcile(draft);
          } catch (reconciliationError) {
            lastError = jiraError(reconciliationError);
            break;
          }
          if (reconciled) return reconciled;
          if (attempt + 1 < dependencies.config.maxCreateAttempts) await sleep(retryDelay(error, attempt));
        }
      }
      const completedDuringFinalization = markFailedOrReturnCreated(draft, lastError.code);
      if (completedDuringFinalization) return completedDuringFinalization;
      throw lastError;
    })();
    inFlight.set(draft.id, work);
    void work.finally(() => inFlight.delete(draft.id)).catch(() => undefined);
    return work;
  };

  const getContext = async (source: JiraContextParams): Promise<JiraContextResult> => {
    if (!sourceIsUsable(source)) invalid();
    const draftId = (source as JiraContextParams & { readonly id?: unknown }).id;
    if (typeof draftId === "string") {
      const cached = draftContexts.get(draftId);
      if (cached) return cached;
    }
    try {
      return await dependencies.jira.getContext();
    } catch (error) {
      throw jiraError(error);
    }
  };

  return {
    getContext,

    async prepare(input) {
      if (!sourceIsUsable(input)
        || !nonblankEnglishReady(input.title, MAX_TITLE_LENGTH)
        || !nonblankEnglishReady(input.description, MAX_DESCRIPTION_LENGTH)
        || !input.missingFields.every((field) => nonblankEnglishReady(field, 200))
        || (input.storyPoints !== undefined && !storyPointsValue.test(input.storyPoints))) invalid();
      const context = await getContext(input);
      if (!dependencies.config.allowedIssueTypes.includes(input.issueType)
        || !context.issueTypes.some((type) => type.name === input.issueType)
        || !context.priorities.some((priority) => priority.id === dependencies.config.defaultPriorityId)) invalid();
      const suggestedEpic = selectSuggestedEpic(context.epicCandidates, input.epicKey && input.epicConfidence
        ? { key: input.epicKey, confidence: input.epicConfidence, evidence: input.epicEvidence ?? "" }
        : null);
      const preparedDraft = {
        ...input,
        priorityId: dependencies.config.defaultPriorityId,
        epicKey: suggestedEpic,
        ...(suggestedEpic ? { epicConfidence: input.epicConfidence, epicEvidence: input.epicEvidence } : {}),
      };
      // DraftStore persists `null` for a deliberate No Epic selection. Its older
      // intersection signature cannot express that nullable override yet.
      const createdAt = now();
      let draft: DraftRecord;
      try {
        draft = dependencies.draftStore.create(preparedDraft as unknown as Parameters<DraftStore["create"]>[0], {
          now: createdAt, expiresAt: createdAt + dependencies.config.draftTtlMs,
        });
      } catch (error) {
        throw storeError(error);
      }
      draftContexts.set(draft.id, context);
      try {
        await dependencies.slack.postTicketPreview(draft);
      } catch {
        throw new TicketWorkflowError("SLACK_DELIVERY_FAILED");
      }
      return draft;
    },

    getRequesterDraft: requesterDraft,

    async edit(request) {
      requesterDraft(request.draftId, request.requesterUserId);
      const context = draftContexts.get(request.draftId)
        ?? await getContext({ ...requesterDraft(request.draftId, request.requesterUserId) });
      validatePatch(request.patch, context);
      let edited: DraftRecord;
      try {
        edited = dependencies.draftStore.edit(request.draftId, request.expectedVersion, request.requesterUserId, request.patch, now());
      } catch (error) {
        throw storeError(error);
      }
      try {
        await dependencies.slack.postTicketPreview(edited);
      } catch {
        throw new TicketWorkflowError("SLACK_DELIVERY_FAILED");
      }
      return edited;
    },

    async cancel(draftId, requesterUserId) {
      const draft = requesterDraft(draftId, requesterUserId);
      if (draft.status !== "Drafted" && draft.status !== "Edited") throw new TicketWorkflowError("DRAFT_STATE_INVALID");
      try {
        dependencies.draftStore.transition(draftId, draft.status, "Cancelled", requesterUserId, now());
      } catch (error) {
        throw storeError(error);
      }
    },

    async approveAndCreate(request) {
      let draft = requesterDraft(request.draftId, request.requesterUserId);
      if (draft.version !== request.version) throw new TicketWorkflowError("DRAFT_STALE");
      if (draft.status === "Created") {
        await deliverTicketLink(draft);
        return draftResult(draft);
      }
      try {
        if (draft.status === "Failed") {
          draft = dependencies.draftStore.transition(draft.id, "Failed", "Creating", request.requesterUserId, now());
          return createFromCreating(draft, draft.failureCode === "JIRA_AMBIGUOUS" || draft.failureCode === "JIRA_NETWORK");
        }
        const approved = dependencies.draftStore.approve(draft.id, request.version, request.requesterUserId, now());
        if (approved.status === "Created") return draftResult(approved);
        if (approved.status === "Approved") {
          draft = dependencies.draftStore.transition(approved.id, "Approved", "Creating", request.requesterUserId, now());
          return createFromCreating(draft, false);
        }
        if (approved.status === "Creating") return createFromCreating(approved, true);
        throw new TicketWorkflowError("DRAFT_STATE_INVALID");
      } catch (error) {
        if (error instanceof TicketWorkflowError) throw error;
        throw storeError(error);
      }
    },

    async retryLinkPost(draftId, requesterUserId) {
      const draft = requesterDraft(draftId, requesterUserId);
      if (draft.status !== "Created") throw new TicketWorkflowError("DRAFT_STATE_INVALID");
      await deliverTicketLink(draft);
    },
  };
}
