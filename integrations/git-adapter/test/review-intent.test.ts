import test from "node:test";
import assert from "node:assert/strict";
import type { PullRequestSnapshot } from "../core.js";
import { classifyFindingRelevance, resolveReviewIntent } from "../review-intent.js";

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: "example-org/gitops",
    pullRequest: 206,
    baseBranch: "main",
    mergeBase: "a".repeat(40),
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedFiles: [{ status: "M", path: "chart/service/api/values/prd/worker/secondary-2.yaml" }],
    commits: ["feat(worker): add workerNodeGroup and nodeSelector for secondary-2"],
    terraformDiff: [
      "+++ b/chart/service/api/values/prd/worker/secondary-2.yaml",
      "+workerNodeGroup: eks-worker-od-wl-prd",
      "+nodeSelector:",
      "+  nodegroup_type: eks-worker-od-wl-prd",
    ].join("\n"),
    diffTruncated: false,
    safety: { secretsRedacted: true, workingTreeChanged: false, pushedRemoteChanges: false, fetchedInto: [] },
    ...overrides,
  };
}

test("infers a high-confidence node-placement target", () => {
  const intent = resolveReviewIntent(snapshot());
  assert.equal(intent.confidence, "high");
  assert.deepEqual(intent.domains, ["node-placement"]);
  assert.ok(intent.changedKeys.includes("workerNodeGroup"));
  assert.ok(intent.affectedComponents.includes("service/api"));
  assert.ok(intent.acceptanceCriteria.some((item) => item.includes("consumed")));
});

test("separates target, cross-cutting, and baseline findings", () => {
  const intent = resolveReviewIntent(snapshot());
  assert.equal(classifyFindingRelevance({ id: "HELM-TEMPLATE", title: "render failed", category: "correctness", addedInPullRequest: true }, intent).relevance, "target");
  assert.equal(classifyFindingRelevance({ id: "TRIVY-SECRET", title: "secret literal", category: "secrets", addedInPullRequest: true }, intent).relevance, "cross-cutting");
  assert.equal(classifyFindingRelevance({ id: "HELM-LINT-BASELINE", title: "baseline lint", category: "correctness", addedInPullRequest: false }, intent).relevance, "baseline");
});

test("requires human confirmation when intent evidence is weak", () => {
  const intent = resolveReviewIntent(snapshot({ commits: ["update config"], terraformDiff: "+enabled: true" }));
  assert.equal(intent.confidence, "low");
});

test("prioritizes PR title and explicit acceptance criteria over generic commits", () => {
  const intent = resolveReviewIntent(snapshot({
    commits: ["update values"],
    pullRequestContext: {
      source: "github-cli-oauth-broker",
      title: "Move API workloads to the on-demand production node group",
      bodySummary: "Acceptance criteria: workloads render with nodeSelector on the intended group\n- [ ] HPA remains valid",
      draft: false,
      state: "open",
      labels: ["infrastructure"],
      comments: ["Please verify tolerations and capacity."],
      reviews: [{ state: "CHANGES_REQUESTED", summary: "Confirm scheduling behavior." }],
      untrusted: true,
    },
  }));
  assert.equal(intent.objective, "Move API workloads to the on-demand production node group");
  assert.equal(intent.confidence, "high");
  assert.ok(intent.acceptanceCriteria.includes("workloads render with nodeSelector on the intended group"));
  assert.ok(intent.acceptanceCriteria.includes("HPA remains valid"));
  assert.equal(intent.contextSummary.commentCount, 1);
  assert.deepEqual(intent.contextSummary.reviewStates, ["CHANGES_REQUESTED"]);
  assert.equal(intent.unknowns.some((item) => item.includes("title/body")), false);
});

test("recognizes Datadog Service Catalog intent and path environment", () => {
  const intent = resolveReviewIntent(snapshot({
    repository: "Example/service-catalog",
    pullRequest: 9,
    changedFiles: [{ status: "A", path: "services-catalog/dev/api/entity.datadog.yaml" }],
    commits: ["feat: add Datadog Service Catalog entry for API"],
    terraformDiff: [
      "+++ b/services-catalog/dev/api/entity.datadog.yaml",
      "+apiVersion: v3",
      "+kind: service",
      "+metadata:",
      "+  name: api-dev",
    ].join("\n"),
    pullRequestContext: {
      source: "github-cli-oauth-broker",
      title: "Add config file for batch 1 - dev env",
      bodySummary: "",
      draft: false,
      state: "open",
      labels: [],
      comments: [],
      reviews: [],
      untrusted: true,
    },
  }));
  assert.deepEqual(intent.domains, ["service-catalog"]);
  assert.deepEqual(intent.environments, ["dev"]);
  assert.ok(intent.acceptanceCriteria.some((item) => item.includes("Datadog Service Catalog v3")));
  assert.equal(classifyFindingRelevance({
    id: "FRIDAY-DATADOG-OWNER-001",
    title: "Datadog catalog entry has no owner",
    category: "other",
    addedInPullRequest: true,
  }, intent).relevance, "target");
});
