/**
 * OpenClaw plugin entrypoint for Friday's bounded Git and PR-review tools.
 * This file only adapts typed contracts to engine calls; capability logic stays
 * in the engine modules so it remains testable without the gateway.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import path from "node:path";
import {
  batchPullRequestReviewSchema,
  gitPullRequestContextSchema,
  gitReadFileSchema,
  gitOpsReviewSchema,
  terraformReviewSchema,
  unifiedPullRequestReviewSchema,
  toolResult,
  type GitPullRequestContextParams,
  type BatchPullRequestReviewParams,
  type GitReadFileParams,
  type GitOpsReviewParams,
  type TerraformReviewParams,
  type UnifiedPullRequestReviewParams,
} from "@friday/shared";
import {
  preparePullRequest,
  readRepositoryFile,
  type SnapshotCacheEntry,
} from "./core.js";
import { openFridayCacheDatabase } from "./sqlite-store.js";
import { reviewTerraformPullRequest } from "./terraform-review.js";
import { reviewGitOpsPullRequest } from "./gitops-review.js";
import { reviewUnifiedPullRequest } from "./unified-review.js";
import { reviewPullRequestBatch } from "./batch-review.js";
import { configureReviewRuntime } from "./runtime-config.js";

export default definePluginEntry({
  id: "friday-git-adapter",
  name: "Friday Git Adapter",
  description: "Controlled local Git fetch plus Terraform and GitOps review engines for Friday.",
  register(api) {
    configureReviewRuntime(api.pluginConfig);
    const database = openFridayCacheDatabase(path.join(
      api.runtime.state.resolveStateDir(),
      "friday-cache.sqlite",
    ));
    const snapshotCache = database.openStore<SnapshotCacheEntry>({
      namespace: "friday-cache-v3:pr-snapshot",
      maxEntries: 64,
    });
    api.on("gateway_stop", () => database.close());
    api.registerTool(
      {
        name: "friday_git_pr_context",
        description:
          "Fetch a pull request from one of Friday's configured allowlisted local repositories into isolated refs/friday refs without changing the working tree or pushing, then return a redacted Terraform, YAML, JSON, Helm-template, and Markdown configuration diff with bounded PR title/body/comment/review context when the local GitHub credential reader is available.",
        parameters: gitPullRequestContextSchema,
        async execute(_id, params: GitPullRequestContextParams) {
          return toolResult(await preparePullRequest(params.pullRequestUrl, { snapshotCache }));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "friday_git_read_file",
        description:
          "Read one allowlisted Terraform, HCL, JSON, YAML, Helm-template, or Markdown file from the isolated base or PR Git ref. Blocks Git metadata, Terraform state/cache, environment files, credentials, scripts, and private keys; redacts secret-like literals.",
        parameters: gitReadFileSchema,
        async execute(_id, params: GitReadFileParams) {
          return toolResult(await readRepositoryFile(params));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "friday_terraform_review",
        description:
          "Run Friday Review Engine v1.1 against a private temporary Terraform PR snapshot: deterministic secret policy, TFLint, and Trivy misconfiguration/secret scanning; changed-line attribution, deduplication, and a fail-closed merge gate. Secret values and code excerpts are never returned. Never runs terraform init, plan, apply, scanner updates, arbitrary commands, or Git writes beyond refs/friday metadata.",
        parameters: terraformReviewSchema,
        async execute(_id, params: TerraformReviewParams) {
          return toolResult(await reviewTerraformPullRequest(params));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "friday_gitops_review",
        description:
          "Run the Helm/YAML/JSON review path in a private temporary snapshot for any allowlisted repository. It uses PR metadata when available, compares base/head Helm renders, traces changed values, separates target/cross-cutting/baseline findings, validates GitOps/HPA policy, and runs applicable local validators without cluster or write access.",
        parameters: gitOpsReviewSchema,
        async execute(_id, params: GitOpsReviewParams) {
          return toolResult(await reviewGitOpsPullRequest(params));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "friday_unified_pr_review",
        description:
          "Run Unified PR Review Engine v3 for an allowlisted infrastructure PR. It always runs full deterministic validation for applicable Terraform and Helm/YAML/JSON checks and may recommend merge; there is no fast or detail mode. PASS receives a compact presentation. WARN, NEEDS_HUMAN, and BLOCK receive bounded plain-language actions plus up to two adapter-supplied, redacted snippets when safe. Lead the response with the explicit merge decision, explain the PR objective in plain Vietnamese, and never let a pre-existing baseline issue change the tool gate. Read-only: no checkout, push, comment, merge, cluster connection or infrastructure mutation.",
        parameters: unifiedPullRequestReviewSchema,
        async execute(_id, params: UnifiedPullRequestReviewParams) {
          return toolResult(await reviewUnifiedPullRequest(params));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "friday_batch_pr_review",
        description:
          "Run Batch PR Review v1 for two to five allowlisted infrastructure pull requests. Reviews at most two PRs concurrently through Unified PR Review Engine v3, preserves input order, isolates per-PR failures, and returns one bounded aggregate with every PR represented exactly once. Read-only: no checkout, push, comment, merge, cluster connection, deployment, or infrastructure mutation.",
        parameters: batchPullRequestReviewSchema,
        async execute(_id, params: BatchPullRequestReviewParams) {
          return toolResult(await reviewPullRequestBatch(params));
        },
      },
      { optional: true },
    );
  },
});
