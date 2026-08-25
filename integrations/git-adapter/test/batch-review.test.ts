import test from "node:test";
import assert from "node:assert/strict";
import { reviewPullRequestBatch } from "../batch-review.js";
import { configureTestRuntime } from "./runtime-fixture.js";

configureTestRuntime();

function mockReview(url: string, verdict: "PASS" | "WARN" | "NEEDS_HUMAN" | "BLOCK" = "PASS") {
  const match = url.match(/github\.com\/(example-org\/[^/]+)\/pull\/(\d+)/);
  const repository = match?.[1] ?? "example-org/gitops";
  const pullRequest = Number(match?.[2] ?? 1);
  return {
    repository,
    pullRequest,
    pr: { title: `PR ${pullRequest}`, state: "open", draft: false, labels: [], contextSource: "test" },
    intent: { objective: `Review PR ${pullRequest}`, affectedComponents: [], environments: [], changedKeys: [] },
    changeSummary: { changedFiles: 1, commits: [], affectedComponents: [], environments: [], changedKeys: [] },
    coverage: { terraform: [], helmYamlJson: ["values.yaml"], documentation: [], unsupported: [], engines: ["helm-yaml-json"], diffTruncated: false },
    engineResults: [],
    gate: { verdict, reviewComplete: true, mergeRecommended: verdict === "PASS" || verdict === "WARN", reasons: [`${verdict} reason`] },
    presentation: {},
    safety: {},
  } as never;
}

test("reviews up to two PRs concurrently while preserving input order", async () => {
  const urls = [
    "https://github.com/example-org/gitops/pull/218",
    "https://github.com/example-org/cloud-infrastructure/pull/838",
    "https://github.com/example-org/kubernetes-infrastructure/pull/86",
  ];
  let active = 0;
  let peak = 0;
  const result = await reviewPullRequestBatch({ pullRequestUrls: urls }, {
    reviewer: async ({ pullRequestUrl }) => {
      active += 1;
      peak = Math.max(peak, active);
      const number = Number(pullRequestUrl.split("/").pop());
      await new Promise((resolve) => setTimeout(resolve, number === 218 ? 20 : 2));
      active -= 1;
      return mockReview(pullRequestUrl, number === 838 ? "WARN" : "PASS");
    },
  });
  assert.equal(peak, 2);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.reviewed, 3);
  assert.deepEqual(result.items.map((item) => item.pullRequestUrl), urls);
  assert.equal(result.counts.WARN, 1);
  assert.equal(result.overallVerdict, "WARN");
});

test("isolates a failed PR and marks the aggregate partial", async () => {
  const urls = [
    "https://github.com/example-org/gitops/pull/218",
    "https://github.com/example-org/gitops/pull/219",
  ];
  const result = await reviewPullRequestBatch({ pullRequestUrls: urls }, {
    reviewer: async ({ pullRequestUrl }) => {
      if (pullRequestUrl.endsWith("/219")) throw new Error("fetch failed");
      return mockReview(pullRequestUrl, "BLOCK");
    },
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.reviewed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.overallVerdict, "NEEDS_HUMAN");
  assert.deepEqual(result.items.map((item) => item.status), ["reviewed", "failed"]);
});

test("rejects unsafe batch inputs before running reviews", async () => {
  await assert.rejects(() => reviewPullRequestBatch({ pullRequestUrls: [
    "https://github.com/example-org/gitops/pull/218",
  ] }), /requires 2-5/);
  await assert.rejects(() => reviewPullRequestBatch({ pullRequestUrls: [
    "https://github.com/example-org/gitops/pull/218",
    "https://github.com/example-org/gitops/pull/218/",
  ] }), /duplicate/);
  await assert.rejects(() => reviewPullRequestBatch({ pullRequestUrls: [
    "https://github.com/example-org/gitops/pull/218",
    "https://github.com/example-org/not-allowed/pull/1",
  ] }), /allowlist/);
});
