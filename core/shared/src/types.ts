/** Minimal JSON and tool-result contracts shared across Friday packages. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  readonly type: "object";
  readonly additionalProperties: boolean;
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
}

export interface JsonSchemaProperty {
  readonly type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: JsonSchemaProperty;
}

export interface ToolTextResult<T> {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: T;
}

export type JiraIssueType = "Task" | "Bug" | "Story";
export type JiraEpicConfidence = "high" | "medium" | "low";

export interface SlackTicketSource {
  readonly slackAccountId: string;
  readonly slackWorkspaceId: string;
  readonly slackChannelId: string;
  readonly threadTs: string;
  readonly requesterUserId: string;
  readonly snapshotCutoffTs: string;
}

export interface JiraDraftInput extends SlackTicketSource {
  readonly title: string;
  readonly issueType: JiraIssueType;
  readonly description: string;
  readonly references: readonly string[];
  readonly missingFields: readonly string[];
  readonly epicKey?: string;
  readonly epicConfidence?: JiraEpicConfidence;
  readonly epicEvidence?: string;
  /** Optional Jira duration expression, for example "4h" or "2d 3h". */
  readonly storyPoints?: string;
}

export type JiraContextParams = SlackTicketSource;
export type JiraPrepareTicketParams = JiraDraftInput;
export type JiraContextToolParams = Record<never, never>;
export type JiraPrepareTicketToolParams = Omit<JiraDraftInput, keyof SlackTicketSource>;

export interface JiraEpicCandidate {
  readonly key: string;
  readonly summary: string;
  readonly description: string;
  readonly labels: readonly string[];
  readonly components: readonly string[];
}

export interface JiraContextResult {
  readonly project: { readonly id: string; readonly key: "ED"; readonly name: string };
  readonly issueTypes: readonly { readonly id: string; readonly name: JiraIssueType }[];
  readonly priorities: readonly { readonly id: string; readonly name: string }[];
  readonly epicCandidates: readonly JiraEpicCandidate[];
}

export interface JiraPreparedDraftResult {
  readonly draftId: string;
  readonly version: number;
  readonly status: "Drafted";
  readonly reviewDelivery: "ephemeral";
}

export interface SafetyEnvelope {
  readonly secretsRedacted: boolean;
  readonly workingTreeChanged?: boolean;
  readonly pushedRemoteChanges?: boolean;
  readonly writeOperationsAvailable?: boolean;
}
