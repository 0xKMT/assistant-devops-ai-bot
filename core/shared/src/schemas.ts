/**
 * JSON schemas and TypeScript inputs for the bounded tools exposed by Friday.
 * Keep these contracts free of OpenClaw-specific runtime types so another host
 * can reuse the same capability interface later.
 */
import type { JsonSchema } from "./types.js";

export type FridayRepositorySlug = string;

export interface GitPullRequestContextParams {
  readonly pullRequestUrl: string;
}

export interface GitReadFileParams {
  readonly repository: FridayRepositorySlug;
  readonly path: string;
  readonly source: "base" | "pr";
  readonly prNumber?: number;
}

export interface TerraformReviewParams {
  readonly pullRequestUrl: string;
}

export interface GitOpsReviewParams {
  readonly pullRequestUrl: string;
}

export interface UnifiedPullRequestReviewParams {
  readonly pullRequestUrl: string;
}

export interface BatchPullRequestReviewParams {
  readonly pullRequestUrls: readonly string[];
}

export const gitPullRequestContextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequestUrl"],
  properties: {
    pullRequestUrl: {
      type: "string",
      description: "Full GitHub PR URL for an allowlisted local repository.",
    },
  },
} as const satisfies JsonSchema;

export const gitReadFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "path", "source"],
  properties: {
    repository: {
      type: "string",
      description: "Exact allowlisted repository slug returned by friday_git_pr_context.",
    },
    path: {
      type: "string",
      description: "Allowlisted repository-relative Terraform, HCL, JSON, YAML, Helm template, or Markdown path.",
    },
    source: {
      type: "string",
      enum: ["base", "pr"],
      description: "Read from the fetched base branch snapshot or fetched PR snapshot.",
    },
    prNumber: {
      type: "integer",
      minimum: 1,
      description: "Required when source is pr.",
    },
  },
} as const satisfies JsonSchema;

export const terraformReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequestUrl"],
  properties: {
    pullRequestUrl: {
      type: "string",
      description: "Full GitHub PR URL for an allowlisted repository containing Terraform changes.",
    },
  },
} as const satisfies JsonSchema;

export const gitOpsReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequestUrl"],
  properties: {
    pullRequestUrl: {
      type: "string",
      description: "Full GitHub PR URL for an allowlisted repository containing Helm, YAML, JSON, or Kubernetes changes.",
    },
  },
} as const satisfies JsonSchema;

export const unifiedPullRequestReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequestUrl"],
  properties: {
    pullRequestUrl: {
      type: "string",
      description: "Full GitHub PR URL for one of Friday's configured allowlisted repositories.",
    },
  },
} as const satisfies JsonSchema;

export const batchPullRequestReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequestUrls"],
  properties: {
    pullRequestUrls: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      uniqueItems: true,
      description: "Two to five full GitHub PR URLs from Friday's allowlisted infrastructure repositories.",
      items: {
        type: "string",
        description: "One full GitHub pull-request URL.",
      },
    },
  },
} as const satisfies JsonSchema;

export const jiraContextSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const satisfies JsonSchema;

export const jiraPrepareTicketSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "issueType",
    "description",
    "references",
    "missingFields",
  ],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    issueType: { type: "string", enum: ["Task", "Bug", "Story"] },
    description: { type: "string", minLength: 1, maxLength: 30000 },
    references: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1 },
    },
    missingFields: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1 },
    },
    epicKey: { type: "string", minLength: 1 },
    epicConfidence: { type: "string", enum: ["high", "medium", "low"] },
    epicEvidence: { type: "string", minLength: 1 },
    storyPoints: { type: "string", minLength: 1, maxLength: 16 },
  },
} as const satisfies JsonSchema;
