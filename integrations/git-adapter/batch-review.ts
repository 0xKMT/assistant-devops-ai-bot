/**
 * Bounded batch orchestration over the unified single-PR engine.
 * Concurrency is capped, input order is preserved and one failure cannot erase
 * successful results from the same request.
 */
import type { BatchPullRequestReviewParams } from "@friday/shared";
import { parsePullRequest } from "./core.js";
import { reviewUnifiedPullRequest, type UnifiedVerdict } from "./unified-review.js";

const MAX_BATCH_SIZE = 5;
const MAX_CONCURRENCY = 2;
const MAX_FINDINGS_PER_PR = 3;

type UnifiedReviewResult = Awaited<ReturnType<typeof reviewUnifiedPullRequest>>;
type ReviewRunner = (params: { readonly pullRequestUrl: string }) => Promise<UnifiedReviewResult>;

export interface BatchReviewOptions {
  readonly reviewer?: ReviewRunner;
  readonly concurrency?: number;
}

function verdictRank(verdict: UnifiedVerdict): number {
  return ({ PASS: 0, WARN: 1, NEEDS_HUMAN: 2, BLOCK: 3 })[verdict];
}

function canonicalizePullRequests(values: readonly string[]): string[] {
  if (values.length < 2 || values.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch review requires 2-${MAX_BATCH_SIZE} pull-request URLs.`);
  }
  const canonical = values.map((value) => {
    const parsed = parsePullRequest(value);
    return `https://github.com/${parsed.repository.slug}/pull/${parsed.number}`;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("Batch review does not accept duplicate pull requests.");
  }
  return canonical;
}

function compactFinding(value: unknown) {
  const finding = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    severity: String(finding.severity ?? "UNKNOWN"),
    category: String(finding.category ?? "review"),
    title: String(finding.title ?? finding.message ?? "Material review finding").slice(0, 300),
    file: String(finding.file ?? "").slice(0, 500),
    ...(Number.isSafeInteger(finding.line) ? { line: Number(finding.line) } : {}),
    relevance: String(finding.relevance ?? (finding.addedInPullRequest ? "target" : "changed")),
    remediation: String(finding.remediation ?? "").slice(0, 500),
  };
}

function summarizeReview(index: number, url: string, result: UnifiedReviewResult) {
  const findings = result.engineResults.flatMap(({ result: engineResult }) => {
    const candidate = engineResult as unknown as { readonly findings?: readonly unknown[] };
    return candidate.findings ?? [];
  }).slice(0, MAX_FINDINGS_PER_PR).map(compactFinding);
  return {
    index,
    pullRequestUrl: url,
    status: "reviewed" as const,
    repository: result.repository,
    pullRequest: result.pullRequest,
    title: result.pr.title,
    objective: result.intent.objective,
    verdict: result.gate.verdict,
    mergeRecommended: result.gate.mergeRecommended,
    reviewComplete: result.gate.reviewComplete,
    reasons: result.gate.reasons.slice(0, 4),
    changedFiles: result.changeSummary.changedFiles,
    engines: result.coverage.engines,
    coverageGap: result.coverage.unsupported.length > 0 || result.coverage.diffTruncated,
    findings,
  };
}

function safeFailure(index: number, url: string, error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason = message.includes("allowlist") || message.includes("pull request url")
    ? "PR URL is invalid or outside Friday's repository allowlist."
    : message.includes("access") || message.includes("authentication") || message.includes("fetch")
      ? "Friday could not access or fetch this pull request."
      : "Friday could not complete this review safely.";
  return { index, pullRequestUrl: url, status: "failed" as const, reason };
}

/** Reviews two to five unique PRs and returns exactly one result per input. */
export async function reviewPullRequestBatch(
  params: BatchPullRequestReviewParams,
  options: BatchReviewOptions = {},
) {
  // Phase 1: canonicalize all URLs before starting work so duplicates or an
  // out-of-allowlist PR fail before any partial execution.
  const urls = canonicalizePullRequests(params.pullRequestUrls);
  const reviewer = options.reviewer ?? reviewUnifiedPullRequest;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(options.concurrency ?? MAX_CONCURRENCY)));
  const items: Array<ReturnType<typeof summarizeReview> | ReturnType<typeof safeFailure> | undefined> = new Array(urls.length);
  let cursor = 0;
  // Phase 2: workers share a monotonic cursor. Each slot writes back to its
  // original index, preserving input order despite bounded concurrency.
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= urls.length) return;
      const url = urls[index]!;
      try {
        items[index] = summarizeReview(index, url, await reviewer({ pullRequestUrl: url }));
      } catch (error) {
        items[index] = safeFailure(index, url, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  // Phase 3: aggregate failures without dropping successful reviews. Any failed
  // item forces human attention but does not invent a verdict for that PR.
  const completedItems = items.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const reviewed = completedItems.filter((item) => item.status === "reviewed");
  const failed = completedItems.length - reviewed.length;
  const counts: Record<UnifiedVerdict, number> = { PASS: 0, WARN: 0, NEEDS_HUMAN: 0, BLOCK: 0 };
  for (const item of reviewed) counts[item.verdict] += 1;
  const overallVerdict = reviewed.reduce<UnifiedVerdict>((current, item) =>
    verdictRank(item.verdict) > verdictRank(current) ? item.verdict : current, "PASS");
  return {
    format: "friday-batch-pr-review-v1",
    status: failed === urls.length ? "FAILED" : failed ? "PARTIAL" : "COMPLETE",
    requested: urls.length,
    reviewed: reviewed.length,
    failed,
    concurrency,
    overallVerdict: failed ? "NEEDS_HUMAN" : overallVerdict,
    counts,
    items: completedItems,
    presentation: {
      headline: failed
        ? `Đã review ${reviewed.length}/${urls.length} PR; ${failed} PR cần chạy lại.`
        : `Đã review đầy đủ ${urls.length}/${urls.length} PR.`,
      rules: [
        "Lead with batch completion and verdict counts.",
        "List every PR exactly once in input order with its verdict and one-line reason.",
        "Show at most three material findings per PR and never reproduce secret values or private diffs.",
        "Keep failed PRs separate and never imply they passed review.",
        "Do not merge, comment, push, checkout, deploy, or perform any external write.",
      ],
    },
    safety: {
      workingTreeChanged: false,
      pushedRemoteChanges: false,
      githubWriteAvailable: false,
      clusterConnected: false,
      deploymentApplied: false,
      secretsRedacted: true,
    },
  };
}
