/** Private, bounded Slack review and delivery operations for Jira drafts. */
import type { JiraEpicCandidate, JiraIssueType } from "@friday/shared";
import type { DraftRecord } from "./draft-store.js";
import type { JiraRuntimeConfig } from "./runtime-config.js";

const POST_EPHEMERAL_URL = "https://slack.com/api/chat.postEphemeral";
const OPEN_VIEW_URL = "https://slack.com/api/views.open";
const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const THREAD_REPLIES_URL = "https://slack.com/api/conversations.replies";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SECTION_TEXT = 3_000;
const MAX_PLAIN_TEXT = 75;
const MAX_OPTIONS = 100;
/** Slack static_select option values must be non-empty; this maps back to Jira null. */
export const NO_EPIC_OPTION_VALUE = "no-epic";

export type SlackTicketUiErrorCode =
  | "SLACK_INPUT_INVALID"
  | "SLACK_API_FAILED"
  | "SLACK_NETWORK"
  | "SLACK_RESPONSE_INVALID";

/** Stable, response-body-free error from the Slack UI boundary. */
export class SlackTicketUiError extends Error {
  readonly code: SlackTicketUiErrorCode;

  constructor(code: SlackTicketUiErrorCode) {
    super(code);
    this.name = "SlackTicketUiError";
    this.code = code;
  }
}

export interface SlackTicketUi {
  postTicketPreview(draft: DraftRecord): Promise<void>;
  openTicketEditModal(
    triggerId: string,
    draft: DraftRecord,
    epics: readonly JiraEpicCandidate[],
    priorities: readonly { id: string; name: string }[],
  ): Promise<void>;
  postTicketLink(channelId: string, threadTs: string, issueUrl: string): Promise<void>;
  ticketLinkExists(channelId: string, threadTs: string, issueUrl: string): Promise<boolean>;
}

export interface TicketEditView {
  readonly type: "modal";
  readonly callback_id: "openclaw:friday-jira:edit";
  readonly title: { readonly type: "plain_text"; readonly text: string };
  readonly submit: { readonly type: "plain_text"; readonly text: string };
  readonly close: { readonly type: "plain_text"; readonly text: string };
  readonly private_metadata: string;
  readonly blocks: readonly Record<string, unknown>[];
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function plainText(value: string, maximum = MAX_PLAIN_TEXT): { readonly type: "plain_text"; readonly text: string } {
  return { type: "plain_text", text: truncate(value, maximum) };
}

function markdown(value: string): { readonly type: "mrkdwn"; readonly text: string } {
  return { type: "mrkdwn", text: truncate(value, MAX_SECTION_TEXT) };
}

function callbackValue(draft: DraftRecord): string {
  return `${draft.id}:${draft.version}`;
}

function selectOption(text: string, value: string): { readonly text: { readonly type: "plain_text"; readonly text: string }; readonly value: string } {
  return { text: plainText(text), value };
}

function safeOptions(values: readonly { id: string; name: string }[], maximum: number): readonly { id: string; name: string }[] {
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const value of values) {
    if (typeof value.id !== "string" || !value.id || value.id.length > MAX_PLAIN_TEXT || typeof value.name !== "string" || !value.name || seen.has(value.id)) continue;
    seen.add(value.id);
    result.push(value);
    if (result.length === maximum) break;
  }
  return result;
}

/** Builds the requester-only review blocks; actions carry no ticket content. */
export function buildTicketReviewBlocks(draft: DraftRecord): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: markdown(`*Jira ticket draft*\n*Title:* ${truncate(draft.title, 255)}\n*Issue type:* ${draft.issueType}\n*Priority:* ${draft.priorityId}\n*Story point estimate:* ${draft.storyPoints ?? "Not set"}\n*Epic:* ${draft.epicKey ?? "No Epic"}`),
    },
    { type: "section", text: markdown(`*Description*\n${draft.description}`) },
  ];
  if (draft.missingFields.length) {
    blocks.push({
      type: "section",
      text: markdown(`*Missing information:* ${draft.missingFields.map((field) => truncate(field, 200)).join(", ")}`),
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", action_id: "friday-jira:approve", text: plainText("Approve & Create"), style: "primary", value: callbackValue(draft) },
      { type: "button", action_id: "friday-jira:edit", text: plainText("Edit"), value: callbackValue(draft) },
      { type: "button", action_id: "friday-jira:cancel", text: plainText("Cancel"), style: "danger", value: callbackValue(draft) },
    ],
  });
  return blocks;
}

function selectedOption(options: readonly { readonly text: { readonly type: "plain_text"; readonly text: string }; readonly value: string }[], value: string): { readonly text: { readonly type: "plain_text"; readonly text: string }; readonly value: string } | undefined {
  return options.find((option) => option.value === value);
}

function requiredSelectedOption(
  options: readonly { readonly text: { readonly type: "plain_text"; readonly text: string }; readonly value: string }[],
  value: string,
): { readonly text: { readonly type: "plain_text"; readonly text: string }; readonly value: string } {
  const selected = selectedOption(options, value);
  if (!selected) throw new SlackTicketUiError("SLACK_INPUT_INVALID");
  return selected;
}

/** Builds an English modal with exactly the five editable Jira draft fields. */
export function buildTicketEditView(
  draft: DraftRecord,
  epics: readonly JiraEpicCandidate[] = [],
  priorities: readonly { id: string; name: string }[] = [],
): TicketEditView {
  const issueTypes: readonly JiraIssueType[] = ["Task", "Bug", "Story"];
  const priorityOptions = safeOptions(priorities.slice(0, MAX_OPTIONS), MAX_OPTIONS).map((priority) => selectOption(priority.name, priority.id));
  const boundedEpics = epics.slice(0, MAX_OPTIONS - 1);
  const epicOptions = [
    selectOption("No Epic", NO_EPIC_OPTION_VALUE),
    ...safeOptions(boundedEpics.map((epic) => ({ id: epic.key, name: `${epic.key}: ${epic.summary}` })), MAX_OPTIONS - 1)
      .map((epic) => selectOption(epic.name, epic.id)),
  ];
  const issueTypeOptions = issueTypes.map((issueType) => selectOption(issueType, issueType));
  const privateMetadata = JSON.stringify({
    pluginInteractiveData: `friday-jira:edit:${draft.id}:${draft.version}`,
    draftId: draft.id,
    version: draft.version,
    userId: draft.requesterUserId,
    channelId: draft.slackChannelId,
  });

  return {
    type: "modal",
    callback_id: "openclaw:friday-jira:edit",
    title: plainText("Edit Jira ticket", 24),
    submit: plainText("Save", 24),
    close: plainText("Cancel", 24),
    private_metadata: privateMetadata,
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: plainText("Title"),
        element: { type: "plain_text_input", action_id: "title", initial_value: truncate(draft.title, MAX_SECTION_TEXT) },
      },
      {
        type: "input",
        block_id: "issueType",
        label: plainText("Issue type"),
        element: { type: "static_select", action_id: "issueType", options: issueTypeOptions, initial_option: selectedOption(issueTypeOptions, draft.issueType) },
      },
      {
        type: "input",
        block_id: "description",
        label: plainText("Description"),
        element: { type: "plain_text_input", action_id: "description", multiline: true, initial_value: truncate(draft.description, MAX_SECTION_TEXT) },
      },
      {
        type: "input",
        block_id: "storyPoints",
        optional: true,
        label: plainText("Story point estimate (optional)"),
        element: { type: "plain_text_input", action_id: "storyPoints", ...(draft.storyPoints ? { initial_value: draft.storyPoints } : {}), placeholder: plainText("e.g. 3 or 5") },
      },
      {
        type: "input",
        block_id: "priority",
        label: plainText("Priority"),
        element: { type: "static_select", action_id: "priority", options: priorityOptions, initial_option: requiredSelectedOption(priorityOptions, draft.priorityId) },
      },
      {
        type: "input",
        block_id: "epic",
        optional: true,
        label: plainText("Epic"),
        element: { type: "static_select", action_id: "epic", options: epicOptions, initial_option: requiredSelectedOption(epicOptions, draft.epicKey ?? NO_EPIC_OPTION_VALUE) },
      },
    ],
  };
}

function nonEmpty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function validIssueUrl(value: string, config: JiraRuntimeConfig): boolean {
  try {
    const url = new URL(value);
    return value === url.toString()
      && url.protocol === "https:"
      && url.origin === config.jira.baseUrl.origin
      && /^\/browse\/ED-\d+$/.test(url.pathname)
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
  }
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SlackTicketUiError) throw error;
    throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
    }
  }
}

function slackSuccess(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { ok?: unknown }).ok === true);
}

/** Creates the only three proactive Slack operations used by the Jira workflow. */
export function createSlackTicketUi(config: JiraRuntimeConfig, fetchImpl: typeof fetch = fetch): SlackTicketUi {
  const post = async (url: string, body: Record<string, unknown>): Promise<void> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secrets.slackBotToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new SlackTicketUiError("SLACK_NETWORK");
    }
    if (!response.ok) throw new SlackTicketUiError("SLACK_API_FAILED");
    const payload = await boundedJson(response);
    if (!slackSuccess(payload)) throw new SlackTicketUiError("SLACK_API_FAILED");
  };

  const get = async (url: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${config.secrets.slackBotToken}` } });
    } catch {
      throw new SlackTicketUiError("SLACK_NETWORK");
    }
    if (!response.ok) throw new SlackTicketUiError("SLACK_API_FAILED");
    const payload = await boundedJson(response);
    if (!slackSuccess(payload)) throw new SlackTicketUiError("SLACK_API_FAILED");
    return payload;
  };

  return {
    postTicketPreview(draft) {
      return post(POST_EPHEMERAL_URL, {
        channel: draft.slackChannelId,
        user: draft.requesterUserId,
        thread_ts: draft.threadTs,
        text: "Your Jira ticket draft is ready for review.",
        blocks: buildTicketReviewBlocks(draft),
      });
    },

    openTicketEditModal(triggerId, draft, epics, priorities) {
      if (!nonEmpty(triggerId)) return Promise.reject(new SlackTicketUiError("SLACK_INPUT_INVALID"));
      return post(OPEN_VIEW_URL, { trigger_id: triggerId, view: buildTicketEditView(draft, epics, priorities) });
    },

    postTicketLink(channelId, threadTs, issueUrl) {
      if (!nonEmpty(channelId) || !nonEmpty(threadTs) || !validIssueUrl(issueUrl, config)) {
        return Promise.reject(new SlackTicketUiError("SLACK_INPUT_INVALID"));
      }
      return post(POST_MESSAGE_URL, { channel: channelId, thread_ts: threadTs, text: issueUrl });
    },

    async ticketLinkExists(channelId, threadTs, issueUrl) {
      if (!nonEmpty(channelId) || !nonEmpty(threadTs) || !validIssueUrl(issueUrl, config)) {
        throw new SlackTicketUiError("SLACK_INPUT_INVALID");
      }
      let cursor = "";
      for (let page = 0; page < 3; page += 1) {
        const query = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "100", ...(cursor ? { cursor } : {}) });
        const payload = await get(`${THREAD_REPLIES_URL}?${query}`);
        const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
        if (!root) throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
        const messages = root.messages;
        if (!Array.isArray(messages) || messages.length > 100) throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
        if (messages.some((message) => message && typeof message === "object" && !Array.isArray(message)
          && (message as { text?: unknown }).text === issueUrl)) return true;
        const metadata = root.response_metadata && typeof root.response_metadata === "object" && !Array.isArray(root.response_metadata)
          ? root.response_metadata as { next_cursor?: unknown } : undefined;
        const next = typeof metadata?.next_cursor === "string" ? metadata.next_cursor : "";
        if (root.has_more !== true || !next) return false;
        cursor = next;
      }
      throw new SlackTicketUiError("SLACK_RESPONSE_INVALID");
    },
  };
}
