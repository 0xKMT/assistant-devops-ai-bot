/** Bounded Jira Cloud v3 calls for Friday's requester-approved ticket workflow. */
import { createHash } from "node:crypto";
import type { JiraContextResult, JiraEpicCandidate, JiraIssueType } from "@friday/shared";
import type { JiraRuntimeConfig } from "./runtime-config.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 16 * 1024;
const MAX_CORRELATION_ID_LENGTH = 512;
const storyPointsValue = /^(?=.{1,16}$)(?:[1-9]\d*(?:\.\d+)?|0\.\d+)$/;
const MAX_RECONCILIATION_RESULTS = 2;
const MAX_RETRY_AFTER_MS = 30_000;
const PROJECT_NAME = "Everfit Devops";
const issueKey = /^ED-\d+$/;

export type JiraClientErrorCode =
  | "JIRA_AUTH"
  | "JIRA_FORBIDDEN"
  | "JIRA_RATE_LIMITED"
  | "JIRA_TRANSIENT"
  | "JIRA_REQUEST_FAILED"
  | "JIRA_NETWORK"
  | "JIRA_RESPONSE_INVALID"
  | "JIRA_METADATA_INVALID"
  | "JIRA_RECONCILIATION_AMBIGUOUS"
  | "JIRA_INPUT_INVALID";

/** Stable, body-free failure returned by the Jira boundary. */
export class JiraClientError extends Error {
  readonly code: JiraClientErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly createRequestSent: boolean;

  constructor(code: JiraClientErrorCode, retryable = false, retryAfterMs?: number, createRequestSent = false) {
    super(code);
    this.name = "JiraClientError";
    this.code = code;
    this.retryable = retryable;
    this.createRequestSent = createRequestSent;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface ApprovedIssueInput {
  readonly title: string;
  readonly issueType: JiraIssueType;
  readonly description: string;
  readonly priorityId: string;
  readonly epicKey: string | null;
  readonly storyPoints?: string | null;
  readonly correlationId: string;
}

export interface JiraClient {
  getContext(): Promise<JiraContextResult>;
  createIssue(input: ApprovedIssueInput): Promise<{ key: string; url: string }>;
  findByCorrelationId(correlationId: string): Promise<{ key: string; url: string } | null>;
}

type UnknownRecord = Record<string, unknown>;
type IssueTypeMetadata = { readonly id: string; readonly name: JiraIssueType };

function object(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function requiredString(value: unknown, maximum: number, code: JiraClientErrorCode = "JIRA_RESPONSE_INVALID"): string {
  const result = boundedString(value, maximum);
  if (!result) throw new JiraClientError(code);
  return result;
}

function requiredArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new JiraClientError("JIRA_RESPONSE_INVALID");
  return value;
}

function correlationLabel(correlationId: string): string {
  const correlation = boundedString(correlationId, MAX_CORRELATION_ID_LENGTH);
  if (!correlation) throw new JiraClientError("JIRA_INPUT_INVALID");
  return `friday-correlation-${createHash("sha256").update(correlation).digest("hex")}`;
}

function toAdf(description: string): UnknownRecord {
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new JiraClientError("JIRA_INPUT_INVALID");
  }
  return {
    type: "doc",
    version: 1,
    content: description.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

function adfText(value: unknown, depth = 0): string {
  if (depth > 12) throw new JiraClientError("JIRA_RESPONSE_INVALID");
  const node = object(value);
  if (!node) throw new JiraClientError("JIRA_RESPONSE_INVALID");
  const text = node.text === undefined ? "" : requiredString(node.text, MAX_DESCRIPTION_LENGTH);
  if (node.content === undefined) return text;
  const content = requiredArray(node.content, 200);
  return `${text}${content.map((child) => adfText(child, depth + 1)).join("")}`;
}

function issueUrl(config: JiraRuntimeConfig, key: string): string {
  if (!issueKey.test(key)) throw new JiraClientError("JIRA_RESPONSE_INVALID");
  return new URL(`/browse/${key}`, config.jira.baseUrl).toString();
}

function parseIssueTypes(payload: unknown, config: JiraRuntimeConfig): readonly IssueTypeMetadata[] {
  const root = object(payload);
  const rawIssueTypes = requiredArray(root?.issueTypes, 50);
  const configured = new Map<JiraIssueType, string>(Object.entries(config.jira.allowedIssueTypes) as [JiraIssueType, string][]);
  const parsed: IssueTypeMetadata[] = [];
  for (const raw of rawIssueTypes) {
    const entry = object(raw);
    const id = boundedString(entry?.id, 100);
    const name = boundedString(entry?.name, 100) as JiraIssueType | null;
    if (!id || !name || configured.get(name) !== id) continue;
    parsed.push({ id, name });
  }
  if (parsed.length !== configured.size) throw new JiraClientError("JIRA_METADATA_INVALID");
  return parsed;
}

function parsePriorities(payload: unknown, config: JiraRuntimeConfig): JiraContextResult["priorities"] {
  const root = object(payload);
  if (root?.priorities === undefined) return [{ id: config.jira.defaultPriorityId, name: "Medium" }];
  const rawPriorities = requiredArray(root.priorities, 50);
  const priorities = rawPriorities.map((raw) => {
    const entry = object(raw);
    return { id: requiredString(entry?.id, 100), name: requiredString(entry?.name, 100) };
  });
  if (!priorities.some((priority) => priority.id === config.jira.defaultPriorityId)) {
    throw new JiraClientError("JIRA_METADATA_INVALID");
  }
  return priorities;
}

function parseEpicCandidate(raw: unknown): JiraEpicCandidate {
  const issue = object(raw);
  const fields = object(issue?.fields);
  const rawLabels = requiredArray(fields?.labels, 50);
  const rawComponents = requiredArray(fields?.components, 50);
  const description = fields?.description === null || fields?.description === undefined ? "" : adfText(fields.description);
  return {
    key: requiredString(issue?.key, 100),
    summary: requiredString(fields?.summary, 255),
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    labels: rawLabels.map((label) => requiredString(label, 100)),
    components: rawComponents.map((component) => requiredString(object(component)?.name, 100)),
  };
}

function parseSearchIssues(payload: unknown, maximum: number): readonly UnknownRecord[] {
  const root = object(payload);
  const issues = requiredArray(root?.issues, maximum);
  return issues.map((issue) => {
    const result = object(issue);
    if (!result) throw new JiraClientError("JIRA_RESPONSE_INVALID");
    return result;
  });
}

function responseError(response: Response): JiraClientError {
  if (response.status === 401) return new JiraClientError("JIRA_AUTH");
  if (response.status === 403) return new JiraClientError("JIRA_FORBIDDEN");
  if (response.status === 429) return new JiraClientError("JIRA_RATE_LIMITED", true, retryAfterMs(response.headers.get("retry-after")));
  if (response.status >= 500 && response.status <= 599) return new JiraClientError("JIRA_TRANSIENT", true);
  return new JiraClientError("JIRA_REQUEST_FAILED");
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? 1 : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(seconds * 1_000)));
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new JiraClientError("JIRA_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new JiraClientError("JIRA_RESPONSE_INVALID");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(concatenate(chunks, length))) as unknown;
  } catch {
    throw new JiraClientError("JIRA_RESPONSE_INVALID");
  }
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Builds a client which can call only Friday's fixed Jira Cloud v3 operations. */
export function createJiraClient(config: JiraRuntimeConfig, fetchImpl: typeof fetch = fetch): JiraClient {
  const basicAuthorization = `Basic ${Buffer.from(`${config.jira.email}:${config.secrets.jiraApiToken}`).toString("base64")}`;
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    try {
      const response = await fetchImpl(new URL(path, config.jira.baseUrl), {
        ...init,
        headers: { accept: "application/json", authorization: basicAuthorization, ...(init.body ? { "content-type": "application/json" } : {}) },
      });
      if (!response.ok) throw responseError(response);
      return responseJson(response);
    } catch (error) {
      if (error instanceof JiraClientError) throw error;
      throw new JiraClientError("JIRA_NETWORK", true);
    }
  };

  const createRequest = async (body: string): Promise<unknown> => {
    try {
      return await request("/rest/api/3/issue", { method: "POST", body });
    } catch (error) {
      if (error instanceof JiraClientError) {
        throw new JiraClientError(error.code, error.retryable, error.retryAfterMs, true);
      }
      throw new JiraClientError("JIRA_NETWORK", true, undefined, true);
    }
  };

  const getCreateFields = async (issueType: JiraIssueType): Promise<{ readonly priorityIds: ReadonlySet<string>; readonly supportsStoryPoints: boolean }> => {
    const issueTypeId = config.jira.allowedIssueTypes[issueType];
    const response = await request(`/rest/api/3/issue/createmeta/${encodeURIComponent(config.jira.projectId)}/issuetypes/${encodeURIComponent(issueTypeId)}`);
    const fields = object(response)?.fields;
    if (!Array.isArray(fields) || fields.length > 100) throw new JiraClientError("JIRA_METADATA_INVALID");
    const labels = fields.filter((field) => {
      const entry = object(field);
      return entry?.fieldId === "labels" || entry?.key === "labels";
    });
    const priorities = fields.filter((field) => {
      const entry = object(field);
      return entry?.fieldId === "priority" || entry?.key === "priority";
    });
    if (labels.length !== 1 || priorities.length !== 1) throw new JiraClientError("JIRA_METADATA_INVALID");
    const allowedValues = object(priorities[0])?.allowedValues;
    if (!Array.isArray(allowedValues) || allowedValues.length === 0 || allowedValues.length > 50) {
      throw new JiraClientError("JIRA_METADATA_INVALID");
    }
    const priorityIds = new Set(allowedValues.map((value) => {
      const id = boundedString(object(value)?.id, 100);
      if (!id) throw new JiraClientError("JIRA_METADATA_INVALID");
      return id;
    }));
    if (priorityIds.size !== allowedValues.length) throw new JiraClientError("JIRA_METADATA_INVALID");
    return {
      priorityIds,
      supportsStoryPoints: fields.some((field) => {
        const entry = object(field);
        return entry?.fieldId === config.jira.storyPointFieldId || entry?.key === config.jira.storyPointFieldId;
      }),
    };
  };

  return {
    async getContext(): Promise<JiraContextResult> {
      const metadata = await request(`/rest/api/3/issue/createmeta/${encodeURIComponent(config.jira.projectId)}/issuetypes`);
      const issueTypes = parseIssueTypes(metadata, config);
      const priorities = parsePriorities(metadata, config);
      const epicSearch = await request("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: config.jira.epicJql,
          fields: ["summary", "description", "labels", "components"],
          maxResults: config.jira.maxEpicCandidates,
        }),
      });
      const epicCandidates = parseSearchIssues(epicSearch, config.jira.maxEpicCandidates).map(parseEpicCandidate);
      return {
        project: { id: config.jira.projectId, key: "ED", name: PROJECT_NAME },
        issueTypes,
        priorities,
        epicCandidates,
      };
    },

    async createIssue(input: ApprovedIssueInput): Promise<{ key: string; url: string }> {
      const title = boundedString(input.title, MAX_TITLE_LENGTH);
      const priorityId = boundedString(input.priorityId, 100);
      const storyPoints = input.storyPoints ?? null;
      if (!title || !priorityId || !config.jira.allowedIssueTypes[input.issueType]) {
        throw new JiraClientError("JIRA_INPUT_INVALID");
      }
      if (input.epicKey !== null && !issueKey.test(input.epicKey)) throw new JiraClientError("JIRA_INPUT_INVALID");
      if (storyPoints !== null && !storyPointsValue.test(storyPoints)) throw new JiraClientError("JIRA_INPUT_INVALID");
      const label = correlationLabel(input.correlationId);
      const createFields = await getCreateFields(input.issueType);
      if (!createFields.priorityIds.has(priorityId)) {
        throw new JiraClientError("JIRA_METADATA_INVALID");
      }
      if (storyPoints !== null && !createFields.supportsStoryPoints) {
        throw new JiraClientError("JIRA_METADATA_INVALID");
      }
      const fields = {
        project: { id: config.jira.projectId },
        issuetype: { id: config.jira.allowedIssueTypes[input.issueType] },
        assignee: { accountId: config.jira.assigneeAccountId },
        priority: { id: priorityId },
        summary: title,
        description: toAdf(input.description),
        labels: [label],
        ...(input.epicKey ? { parent: { key: input.epicKey } } : {}),
        ...(storyPoints !== null ? { [config.jira.storyPointFieldId]: Number(storyPoints) } : {}),
      };
      try {
        const created = object(await createRequest(JSON.stringify({ fields })));
        const key = requiredString(created?.key, 100);
        return { key, url: issueUrl(config, key) };
      } catch (error) {
        if (error instanceof JiraClientError) {
          throw new JiraClientError(error.code, error.retryable, error.retryAfterMs, true);
        }
        throw new JiraClientError("JIRA_NETWORK", true, undefined, true);
      }
    },

    async findByCorrelationId(correlationId: string): Promise<{ key: string; url: string } | null> {
      const label = correlationLabel(correlationId);
      const results = parseSearchIssues(await request("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: `project = ED AND labels = "${label}"`,
          fields: [],
          maxResults: MAX_RECONCILIATION_RESULTS,
        }),
      }), MAX_RECONCILIATION_RESULTS);
      if (results.length === 0) return null;
      if (results.length !== 1) throw new JiraClientError("JIRA_RECONCILIATION_AMBIGUOUS");
      const key = requiredString(results[0]?.key, 100);
      return { key, url: issueUrl(config, key) };
    },
  };
}
