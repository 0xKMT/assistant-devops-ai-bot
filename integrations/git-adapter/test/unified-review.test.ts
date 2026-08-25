import test from "node:test";
import assert from "node:assert/strict";
import { selectReviewSnippets } from "../review-snippets.js";
import { buildHumanFriendlyPresentation, buildUnifiedGate, classifyReviewFiles, reviewUnifiedPullRequest } from "../unified-review.js";
import type { PullRequestSnapshot } from "../core.js";
import { scanGitOpsPolicy, type GitOpsFinding } from "../gitops-review.js";
import type { TerraformFinding } from "../terraform-review.js";

const unifiedSnapshot = {
  repository: "example-org/gitops",
  pullRequest: 42,
  baseBranch: "main",
  mergeBase: "base-sha",
  baseSha: "base-sha",
  headSha: "head-sha",
  changedFiles: [
    { status: "M", path: "infra/main.tf" },
    { status: "M", path: "apps/values.yaml" },
  ],
  commits: ["add review coverage"],
  terraformDiff: [
    "diff --git a/infra/main.tf b/infra/main.tf",
    "--- a/infra/main.tf",
    "+++ b/infra/main.tf",
    "@@ -0,0 +10,2 @@",
    "+resource \"aws_s3_bucket\" \"safe\" {}",
    "+tags = { owner = \"platform\" }",
    "diff --git a/apps/values.yaml b/apps/values.yaml",
    "--- a/apps/values.yaml",
    "+++ b/apps/values.yaml",
    "@@ -0,0 +5,2 @@",
    "+replicaCount: 2",
    "+image: api:v2",
  ].join("\n"),
  diffTruncated: false,
  safety: { secretsRedacted: true, fetchedInto: [] },
} as PullRequestSnapshot;

function terraformFinding(id: string, file: string, line: number | undefined, addedInPullRequest = true): TerraformFinding {
  return {
    tool: "friday-policy", sources: ["friday-policy"], category: "correctness", id, severity: "MEDIUM", file,
    ...(line === undefined ? {} : { line }), title: id, message: id, changedInPullRequest: true, addedInPullRequest,
  };
}

function gitOpsFinding(
  id: string,
  file: string,
  line: number | undefined,
  addedInPullRequest = true,
  category: GitOpsFinding["category"] = "correctness",
): GitOpsFinding {
  return {
    tool: "friday-gitops-policy", sources: ["friday-gitops-policy"], category, id, severity: "MEDIUM", file,
    ...(line === undefined ? {} : { line }), title: id, message: id, changedInPullRequest: true, addedInPullRequest,
  };
}

function mockEngineResult(
  verdict: "PASS" | "WARN" | "NEEDS_HUMAN" | "BLOCK",
  findings: readonly TerraformFinding[] | readonly GitOpsFinding[],
) {
  return {
    findings,
    gate: { verdict, reviewComplete: true, mergeRecommended: verdict === "PASS" || verdict === "WARN", reasons: [] },
  } as never;
}

function unifiedDependencies(options: {
  readonly terraformVerdict?: "PASS" | "WARN" | "NEEDS_HUMAN" | "BLOCK";
  readonly gitOpsVerdict?: "PASS" | "WARN" | "NEEDS_HUMAN" | "BLOCK";
  readonly terraformFindings?: readonly TerraformFinding[];
  readonly gitOpsFindings?: readonly GitOpsFinding[];
  readonly snapshot?: PullRequestSnapshot;
  readonly contextLines?: readonly string[];
} = {}) {
  let selectorDiff: string | undefined;
  let selectorCandidates: readonly { readonly key: string; readonly file: string; readonly line: number }[] = [];
  let engineCalls = 0;
  return {
    dependencies: {
      preparePullRequest: async () => options.snapshot ?? unifiedSnapshot,
      reviewTerraformPullRequest: async () => {
        engineCalls += 1;
        return mockEngineResult(options.terraformVerdict ?? "WARN", options.terraformFindings ?? []);
      },
      reviewGitOpsPullRequest: async () => {
        engineCalls += 1;
        return mockEngineResult(options.gitOpsVerdict ?? "PASS", options.gitOpsFindings ?? []);
      },
      selectReviewSnippets: (diff: string, candidates: readonly { readonly key: string; readonly file: string; readonly line: number }[]) => {
        selectorDiff = diff;
        selectorCandidates = candidates;
        return selectReviewSnippets(diff, candidates);
      },
      readPullRequestFileContext: async (_snapshot: PullRequestSnapshot, file: string, line: number) => options.contextLines
        ? { file, startLine: Math.max(1, line - 4), lines: options.contextLines, secretsRedacted: true as const }
        : undefined,
    } as never,
    selectorState: () => ({ selectorDiff, selectorCandidates, engineCalls }),
  };
}

test("classifies Terraform, Helm/YAML/JSON, docs and unsupported files", () => {
  const coverage = classifyReviewFiles({ changedFiles: [
    { status: "M", path: "infra/main.tf" },
    { status: "M", path: "chart/api/values/prd.yaml" },
    { status: "M", path: "config/policy.json" },
    { status: "A", path: "services-catalog/dev/api/entity.datadog.yaml" },
    { status: "M", path: "README.md" },
    { status: "M", path: "scripts/deploy.sh" },
  ] });
  assert.deepEqual(coverage.terraform, ["infra/main.tf"]);
  assert.deepEqual(coverage.helmYamlJson, ["chart/api/values/prd.yaml", "config/policy.json", "services-catalog/dev/api/entity.datadog.yaml"]);
  assert.deepEqual(coverage.documentation, ["README.md"]);
  assert.deepEqual(coverage.unsupported, ["scripts/deploy.sh"]);
});

test("unified gate preserves a blocker from either review engine", () => {
  const gate = buildUnifiedGate([
    { verdict: "PASS", reviewComplete: true, mergeRecommended: true, reasons: ["Terraform passed."] },
    { verdict: "BLOCK", reviewComplete: true, mergeRecommended: false, reasons: ["Helm regression."] },
  ], { draft: false, unsupportedFiles: 0, applicableEngines: 2 });
  assert.equal(gate.verdict, "BLOCK");
  assert.equal(gate.mergeRecommended, false);
});

test("unified gate requires human review for draft or coverage gaps", () => {
  const draft = buildUnifiedGate([
    { verdict: "PASS", reviewComplete: true, mergeRecommended: true, reasons: [] },
  ], { draft: true, unsupportedFiles: 0, applicableEngines: 1 });
  assert.equal(draft.verdict, "NEEDS_HUMAN");

  const unsupported = buildUnifiedGate([], { draft: false, unsupportedFiles: 1, applicableEngines: 0 });
  assert.equal(unsupported.verdict, "NEEDS_HUMAN");
  assert.equal(unsupported.reviewComplete, false);
});

test("human-friendly output leads with an unambiguous merge decision", () => {
  const presentation = buildHumanFriendlyPresentation({
    verdict: "NEEDS_HUMAN",
    reviewComplete: false,
    mergeRecommended: false,
    reasons: ["Live node placement is not verified."],
  });
  assert.equal(presentation.format, "friday-human-friendly-review-v2");
  assert.equal(presentation.headline, "🟡 CẦN XÁC NHẬN TRƯỚC KHI MERGE");
  assert.equal(presentation.mergeRecommended, false);
  assert.equal(presentation.depth, "detailed");
  assert.equal(presentation.sectionOrder[0], "Verdict");
  assert.ok(presentation.rules.some((rule) => rule.includes("impact")));
  assert.ok(presentation.rules.some((rule) => rule.includes("baseline")));
  assert.ok(presentation.rules.some((rule) => rule.includes("structured gate is authoritative")));
  assert.equal(presentation.limits.actionItems, 5);
  assert.equal(presentation.limits.evidenceItems, 3);
  assert.ok(presentation.rules.some((rule) => rule.includes("BLOCK overall")));
});

test("single review distinguishes compact PASS from detailed non-PASS output", () => {
  const compact = buildHumanFriendlyPresentation({
    verdict: "PASS", reviewComplete: true, mergeRecommended: true, reasons: [],
  });
  const detailed = buildHumanFriendlyPresentation({
    verdict: "WARN", reviewComplete: true, mergeRecommended: true, reasons: [],
  });
  assert.equal(compact.depth, "compact");
  assert.equal(detailed.depth, "detailed");
  assert.equal("outputDetail" in detailed, false);
});

test("non-PASS presentation allows two eight-line action snippets", () => {
  const presentation = buildHumanFriendlyPresentation({
    verdict: "WARN", reviewComplete: true, mergeRecommended: true, reasons: [],
  });
  assert.equal(presentation.limits.snippets, 2);
  assert.equal(presentation.limits.snippetLines, 8);
  assert.ok(presentation.rules.some((rule) => rule.includes("immediately below")));
});

test("single review gives snippets only to non-PASS presentations", () => {
  const warnGate = { verdict: "WARN" as const, reviewComplete: true, mergeRecommended: true, reasons: [] };
  const passGate = { verdict: "PASS" as const, reviewComplete: true, mergeRecommended: true, reasons: [] };
  assert.equal(buildHumanFriendlyPresentation(warnGate).limits.snippets, 2);
  assert.equal(buildHumanFriendlyPresentation(passGate).limits.snippets, 0);
});

test("PASS uses the compact section contract", () => {
  const presentation = buildHumanFriendlyPresentation({
    verdict: "PASS", reviewComplete: true, mergeRecommended: true, reasons: [],
  });
  assert.deepEqual(presentation.sectionOrder, ["Verdict", "Objective", "Reviewed scope", "Limitations"]);
  assert.equal(presentation.limits.actionItems, 0);
  assert.equal(presentation.limits.evidenceItems, 0);
  assert.equal(presentation.limits.expressionsPerAction, 0);
});

test("non-PASS gates use bounded detailed evidence", () => {
  for (const verdict of ["WARN", "NEEDS_HUMAN", "BLOCK"] as const) {
    const presentation = buildHumanFriendlyPresentation({
      verdict,
      reviewComplete: verdict !== "NEEDS_HUMAN",
      mergeRecommended: verdict === "WARN",
      reasons: [],
    });
    assert.equal(presentation.depth, "detailed");
    assert.deepEqual(presentation.sectionOrder, ["Verdict", "Objective", "Findings & actions", "Evidence", "Limitations"]);
    assert.equal(presentation.limits.actionItems, 5);
    assert.equal(presentation.limits.evidenceItems, 3);
  }
});

test("full non-PASS Unified Reviews return bounded snippet evidence", async () => {
  for (const verdict of ["WARN", "BLOCK", "NEEDS_HUMAN"] as const) {
    const fixture = unifiedDependencies({
      terraformVerdict: verdict,
      terraformFindings: [terraformFinding("TF-VALID", "infra/main.tf", 10)],
      gitOpsFindings: [gitOpsFinding("GITOPS-VALID", "apps/values.yaml", 5)],
    });
    const review = await reviewUnifiedPullRequest({
      pullRequestUrl: "https://github.com/example-org/gitops/pull/42",
    }, fixture.dependencies);
    assert.ok("expandedEvidence" in review);
    assert.deepEqual(review.expandedEvidence.snippets.map((snippet) => snippet.key), [
      "TF-VALID:infra/main.tf:10",
      "GITOPS-VALID:apps/values.yaml:5",
    ]);
    assert.ok(review.expandedEvidence.snippets.every((snippet) => snippet.code.split("\n").length <= 8));
  }
});

test("PASS omits snippet evidence while every review runs applicable engines", async () => {
  const passFixture = unifiedDependencies({ terraformVerdict: "PASS", gitOpsVerdict: "PASS" });
  const pass = await reviewUnifiedPullRequest({
    pullRequestUrl: "https://github.com/example-org/gitops/pull/42",
  }, passFixture.dependencies);
  assert.equal("expandedEvidence" in pass, false);
  assert.equal(passFixture.selectorState().engineCalls, 2);
});

test("changed-file findings fall back to bounded redacted file context when no added diff finding exists", async () => {
  const fixture = unifiedDependencies({
    terraformFindings: [terraformFinding("CONTEXT", "infra/main.tf", 20, false)],
    contextLines: [
      "locals {", "  owner = \"platform\"", "  enabled = true", "}",
      "resource \"aws_s3_bucket\" \"safe\" {}", "tags = { owner = local.owner }",
      "lifecycle { prevent_destroy = true }", "}",
    ],
  });
  const review = await reviewUnifiedPullRequest({
    pullRequestUrl: "https://github.com/example-org/gitops/pull/42",
  }, fixture.dependencies);

  assert.ok("expandedEvidence" in review);
  assert.deepEqual(review.expandedEvidence.snippets.map((snippet) => snippet.file), ["infra/main.tf"]);
  assert.ok(review.expandedEvidence.snippets[0]!.code.split("\n").length <= 8);
});

test("Unified Review filters unsafe and baseline findings before selecting snippets", async () => {
  const fixture = unifiedDependencies({
    terraformFindings: [
      terraformFinding("BASELINE", "infra/main.tf", 10, false),
      terraformFinding("MISSING", "infra/main.tf", undefined),
      terraformFinding("FRACTION", "infra/main.tf", 10.5),
      terraformFinding("ZERO", "infra/main.tf", 0),
      terraformFinding("ABSOLUTE", "/infra/main.tf", 10),
      terraformFinding("TRAVERSAL", "../infra/main.tf", 10),
      terraformFinding("BACKSLASH", "infra\\main.tf", 10),
      terraformFinding("NUL", "infra/\0main.tf", 10),
      terraformFinding("NEWLINE", "infra/\nmain.tf", 10),
      terraformFinding("TF-VALID", "infra/main.tf", 10),
    ],
    gitOpsFindings: [gitOpsFinding("GITOPS-VALID", "apps/values.yaml", 5)],
  });
  const review = await reviewUnifiedPullRequest({
    pullRequestUrl: "https://github.com/example-org/gitops/pull/42",
  }, fixture.dependencies);
  assert.ok("expandedEvidence" in review);
  assert.deepEqual(fixture.selectorState().selectorCandidates, [
    { key: "TF-VALID:infra/main.tf:10", file: "infra/main.tf", line: 10 },
    { key: "GITOPS-VALID:apps/values.yaml:5", file: "apps/values.yaml", line: 5 },
  ]);
  assert.equal(fixture.selectorState().selectorDiff, unifiedSnapshot.terraformDiff);
  assert.deepEqual(review.expandedEvidence.snippets.map((snippet) => snippet.key), [
    "TF-VALID:infra/main.tf:10",
    "GITOPS-VALID:apps/values.yaml:5",
  ]);
});

test("Unified Review never returns expanded snippets for secret-category findings", async () => {
  const source = [
    "- name: POSTGRES_PASSWORD",
    "  value: synthetic-password",
  ].join("\n");
  const secretFindings = scanGitOpsPolicy("apps/deployment.yaml", source, new Set([1, 2]));
  assert.equal(secretFindings[0]?.category, "secrets");
  const secretSnapshot = {
    ...unifiedSnapshot,
    changedFiles: [{ status: "M", path: "apps/deployment.yaml" }],
    terraformDiff: [
      "+++ b/apps/deployment.yaml",
      "@@ -1,2 +1,2 @@",
      "+- name: POSTGRES_PASSWORD",
      "+  value: synthetic-password",
    ].join("\n"),
  } as PullRequestSnapshot;
  const fixture = unifiedDependencies({
    snapshot: secretSnapshot,
    terraformVerdict: "PASS",
    gitOpsVerdict: "BLOCK",
    gitOpsFindings: secretFindings,
  });

  const review = await reviewUnifiedPullRequest({
    pullRequestUrl: "https://github.com/example-org/gitops/pull/42",
  }, fixture.dependencies);

  assert.ok("expandedEvidence" in review);
  assert.deepEqual(fixture.selectorState().selectorCandidates, []);
  assert.deepEqual(review.expandedEvidence.snippets, []);
  assert.doesNotMatch(JSON.stringify(review.expandedEvidence), /synthetic-password/);
});

test("single-review presentation requires the adapter-rendered transport and exact language label", () => {
  const presentation = buildHumanFriendlyPresentation({
    verdict: "WARN", reviewComplete: true, mergeRecommended: true, reasons: [],
  });

  assert.ok(presentation.rules.some((rule) => rule.includes("snippet.rendered exactly")));
  assert.ok(presentation.rules.some((rule) => rule.includes("exactly snippet.language")));
  assert.ok(presentation.rules.some((rule) => rule.includes("otherwise no language label")));
});
