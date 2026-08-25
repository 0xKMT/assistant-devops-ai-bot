/** Fail-closed, immutable configuration for the bounded Jira ticket workflow. */
import type { JiraIssueType } from "@friday/shared";

export interface JiraRuntimeConfig {
  readonly jira: {
    readonly baseUrl: URL;
    readonly email: string;
    readonly projectId: string;
    readonly projectKey: "ED";
    readonly assigneeAccountId: string;
    readonly defaultPriorityId: string;
    readonly storyPointFieldId: string;
    readonly allowedIssueTypes: Readonly<Record<JiraIssueType, string>>;
    readonly epicJql: string;
    readonly maxEpicCandidates: number;
  };
  readonly slack: { readonly accountId: string; readonly workspaceId: string };
  readonly workflow: { readonly draftTtlMs: number; readonly maxCreateAttempts: number };
  readonly secrets: { readonly jiraApiToken: string; readonly slackBotToken: string };
}

type RecordValue = Record<string, unknown>;

const issueTypes = ["Task", "Bug", "Story"] as const satisfies readonly JiraIssueType[];
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const boundedEpicJql = /^project\s*=\s*ED\s+AND\s+issuetype\s*=\s*Epic\s+AND\s+statusCategory\s*!=\s*Done$/i;

function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RecordValue;
}

function exactObject(value: unknown, label: string, keys: readonly string[]): RecordValue {
  const result = object(value, label);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${label} contains unsupported or missing fields.`);
  }
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function secret(env: Readonly<Record<string, string | undefined>>, envName: string): string {
  const value = env[envName];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Required secret ${envName} is absent.`);
  return value;
}

function envName(value: unknown, label: string): string {
  const result = string(value, label);
  if (!environmentName.test(result)) throw new Error(`${label} must be a valid environment variable name.`);
  return result;
}

function baseUrl(value: unknown): URL {
  const result = new URL(string(value, "jira.baseUrl"));
  if (result.protocol !== "https:" || !result.hostname) {
    throw new Error("jira.baseUrl must be an HTTPS URL.");
  }
  return result;
}

function parseAllowedIssueTypes(value: unknown): Readonly<Record<JiraIssueType, string>> {
  const source = exactObject(value, "jira.allowedIssueTypes", issueTypes);
  return Object.freeze({
    Task: string(source.Task, "jira.allowedIssueTypes.Task"),
    Bug: string(source.Bug, "jira.allowedIssueTypes.Bug"),
    Story: string(source.Story, "jira.allowedIssueTypes.Story"),
  });
}

function parseEpicJql(value: unknown): string {
  const result = string(value, "jira.epicJql");
  if (!boundedEpicJql.test(result)) {
    throw new Error("jira.epicJql must be bounded to active ED Epics.");
  }
  return result;
}

export function parseJiraRuntimeConfig(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): JiraRuntimeConfig {
  const root = exactObject(value, "Friday Jira config", ["jira", "slack", "workflow"]);
  const jira = exactObject(root.jira, "jira", [
    "baseUrl", "emailEnv", "apiTokenEnv", "projectId", "projectKey", "assigneeAccountId",
    "defaultPriorityId", "storyPointFieldId", "allowedIssueTypes", "epicJql", "maxEpicCandidates",
  ]);
  const slack = exactObject(root.slack, "slack", ["accountId", "workspaceId", "botTokenEnv"]);
  const workflow = exactObject(root.workflow, "workflow", ["draftTtlMinutes", "maxCreateAttempts"]);
  const projectKey = string(jira.projectKey, "jira.projectKey");
  if (projectKey !== "ED") throw new Error("jira.projectKey must be ED.");
  const jiraEmailEnv = envName(jira.emailEnv, "jira.emailEnv");
  const jiraTokenEnv = envName(jira.apiTokenEnv, "jira.apiTokenEnv");
  const slackTokenEnv = envName(slack.botTokenEnv, "slack.botTokenEnv");
  const draftTtlMinutes = integerInRange(workflow.draftTtlMinutes, "workflow.draftTtlMinutes", 5, 10_080);

  return Object.freeze({
    jira: Object.freeze({
      baseUrl: baseUrl(jira.baseUrl),
      email: string(secret(env, jiraEmailEnv), "jira.emailEnv"),
      projectId: string(jira.projectId, "jira.projectId"),
      projectKey: "ED",
      assigneeAccountId: string(jira.assigneeAccountId, "jira.assigneeAccountId"),
      defaultPriorityId: string(jira.defaultPriorityId, "jira.defaultPriorityId"),
      storyPointFieldId: string(jira.storyPointFieldId, "jira.storyPointFieldId"),
      allowedIssueTypes: parseAllowedIssueTypes(jira.allowedIssueTypes),
      epicJql: parseEpicJql(jira.epicJql),
      maxEpicCandidates: integerInRange(jira.maxEpicCandidates, "jira.maxEpicCandidates", 1, 50),
    }),
    slack: Object.freeze({
      accountId: string(slack.accountId, "slack.accountId"),
      workspaceId: string(slack.workspaceId, "slack.workspaceId"),
    }),
    workflow: Object.freeze({
      draftTtlMs: draftTtlMinutes * 60_000,
      maxCreateAttempts: integerInRange(workflow.maxCreateAttempts, "workflow.maxCreateAttempts", 1, 5),
    }),
    secrets: Object.freeze({
      jiraApiToken: secret(env, jiraTokenEnv),
      slackBotToken: secret(env, slackTokenEnv),
    }),
  });
}

let activeConfig: JiraRuntimeConfig | undefined;

/** Installs the validated immutable runtime used by Jira adapter operations. */
export function configureJiraRuntime(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): JiraRuntimeConfig {
  activeConfig = parseJiraRuntimeConfig(value, env);
  return activeConfig;
}

export function jiraRuntime(): JiraRuntimeConfig {
  if (!activeConfig) throw new Error("Friday Jira Adapter is not configured.");
  return activeConfig;
}
