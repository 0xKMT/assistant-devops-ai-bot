/**
 * Routes a PR to the applicable review engines and combines their evidence into
 * one conservative verdict plus a bounded human-facing presentation contract.
 */
import type { UnifiedPullRequestReviewParams } from "@friday/shared";
import { preparePullRequest, readPullRequestFileContext, type PullRequestSnapshot } from "./core.js";
import { reviewGitOpsPullRequest } from "./gitops-review.js";
import { resolveReviewIntent } from "./review-intent.js";
import { selectContextReviewSnippet, selectReviewSnippets, type ReviewSnippet, type SnippetCandidate } from "./review-snippets.js";
import { reviewTerraformPullRequest } from "./terraform-review.js";

export type UnifiedVerdict = "BLOCK" | "NEEDS_HUMAN" | "WARN" | "PASS";
export type PresentationDepth = "compact" | "detailed";
type TerraformReviewResult = Awaited<ReturnType<typeof reviewTerraformPullRequest>>;
type GitOpsReviewResult = Awaited<ReturnType<typeof reviewGitOpsPullRequest>>;

export interface UnifiedReviewDependencies {
  readonly preparePullRequest: (pullRequestUrl: string) => Promise<PullRequestSnapshot>;
  readonly reviewTerraformPullRequest: (
    params: UnifiedPullRequestReviewParams,
    options: { readonly snapshot: PullRequestSnapshot },
  ) => Promise<TerraformReviewResult>;
  readonly reviewGitOpsPullRequest: (
    params: UnifiedPullRequestReviewParams,
    options: { readonly snapshot: PullRequestSnapshot },
  ) => Promise<GitOpsReviewResult>;
  readonly selectReviewSnippets: typeof selectReviewSnippets;
  readonly readPullRequestFileContext: typeof readPullRequestFileContext;
}

const productionDependencies: UnifiedReviewDependencies = {
  preparePullRequest,
  reviewTerraformPullRequest: (params, options) => reviewTerraformPullRequest(params, options),
  reviewGitOpsPullRequest: (params, options) => reviewGitOpsPullRequest(params, options),
  selectReviewSnippets,
  readPullRequestFileContext,
};

export interface ReviewFileCoverage {
  readonly terraform: readonly string[];
  readonly helmYamlJson: readonly string[];
  readonly documentation: readonly string[];
  readonly unsupported: readonly string[];
}

interface EngineGateLike {
  readonly verdict: UnifiedVerdict;
  readonly reviewComplete: boolean;
  readonly mergeRecommended: boolean;
  readonly reasons: readonly string[];
}

export interface HumanFriendlyPresentation {
  readonly format: "friday-human-friendly-review-v2";
  readonly depth: PresentationDepth;
  readonly headline: string;
  readonly decision: string;
  readonly mergeRecommended: boolean;
  readonly sectionOrder: readonly string[];
  readonly rules: readonly string[];
  readonly limits: {
    readonly actionItems: number;
    readonly evidenceItems: number;
    readonly expressionsPerAction: number;
    readonly snippets: number;
    readonly snippetLines: number;
    readonly sentencesPerFinding: number;
  };
}

function presentationDepth(verdict: UnifiedVerdict): PresentationDepth {
  return verdict === "PASS" ? "compact" : "detailed";
}

export function buildHumanFriendlyPresentation(gate: EngineGateLike): HumanFriendlyPresentation {
  const labels: Readonly<Record<UnifiedVerdict, { headline: string; decision: string }>> = {
    BLOCK: {
      headline: "🔴 KHÔNG NÊN MERGE",
      decision: "PR có lỗi mới cần xử lý trước khi merge.",
    },
    NEEDS_HUMAN: {
      headline: "🟡 CẦN XÁC NHẬN TRƯỚC KHI MERGE",
      decision: "Chưa đủ bằng chứng để Friday khuyến nghị merge an toàn.",
    },
    WARN: {
      headline: "🟠 CÓ THỂ MERGE SAU KHI XEM CẢNH BÁO",
      decision: "Không có lỗi chặn, nhưng reviewer nên xem các cảnh báo liên quan.",
    },
    PASS: {
      headline: "🟢 CÓ THỂ TIẾP TỤC MERGE",
      decision: "Không phát hiện lỗi mới trong phạm vi Friday đã kiểm tra.",
    },
  };
  const depth = presentationDepth(gate.verdict);
  const detailed = depth === "detailed";
  return {
    format: "friday-human-friendly-review-v2",
    depth,
    ...labels[gate.verdict],
    mergeRecommended: gate.mergeRecommended,
    sectionOrder: detailed
      ? ["Verdict", "Objective", "Findings & actions", "Evidence", "Limitations"]
      : ["Verdict", "Objective", "Reviewed scope", "Limitations"],
    rules: [
      "Lead with headline and one plain-language decision sentence; never bury the verdict at the end.",
      "Explain the PR objective in at most two short Vietnamese sentences.",
      "Use short bullets and plain Vietnamese; explain uncommon infrastructure terms on first use.",
      "Do not let baseline issues change the PR verdict unless they materially interact with the changed lines.",
      "Never call a baseline-only finding 'BLOCK overall' or let it change the structured gate.",
      "The structured gate is authoritative: reproduce its verdict and merge recommendation exactly; do not infer a stricter verdict from baseline severity.",
      "Do not claim that merge is safe when mergeRecommended is false.",
      "Never reproduce secret values, raw scanner payloads, full private diffs, internal tool names, models, providers, or implementation details.",
      ...(detailed ? [
        "For WARN, NEEDS_HUMAN, and BLOCK, use one combined 'Findings & actions' list; state whether a baseline item was introduced by the PR.",
        "For each actionable item, state impact and next action; show at most five items.",
        "Show at most three concise 'Evidence' bullets with safe file:line evidence when available.",
        "Only adapter-supplied bounded snippets may appear, with at most two snippets total.",
        "Place each returned snippet immediately below the matching action by copying snippet.rendered exactly; never reconstruct or decode its rendering-safe transport.",
        "The returned transport uses exactly snippet.language when provided and otherwise no language label; never infer or substitute a language.",
        "Never place snippets in 'Evidence' or a new top-level section.",
      ] : [
        "For PASS, use only Verdict, Objective, Reviewed scope, and a material Limitations section; do not add baseline, technical-evidence, or snippet sections.",
        "Keep PASS to three to five lines and state that it applies only to the reviewed PR scope.",
      ]),
    ],
    limits: {
      actionItems: detailed ? 5 : 0,
      evidenceItems: detailed ? 3 : 0,
      expressionsPerAction: detailed ? 1 : 0,
      snippets: detailed ? 2 : 0,
      snippetLines: detailed ? 8 : 0,
      sentencesPerFinding: 2,
    },
  };
}

interface NormalizedFindingEvidence {
  readonly id: string;
  readonly category: string;
  readonly file: string;
  readonly line?: number;
  readonly addedInPullRequest: boolean;
  readonly changedInPullRequest: boolean;
}

function isSafeFindingFile(file: string): boolean {
  return file.length > 0
    && !file.startsWith("/")
    && !file.includes("\\")
    && !file.includes("\0")
    && !file.includes("\n")
    && !file.includes("\r")
    && !file.split("/").some((part) => !part || part === "." || part === "..");
}

async function selectExpandedEvidence(
  snapshot: Pick<PullRequestSnapshot, "repository" | "headSha" | "changedFiles" | "terraformDiff">,
  gate: EngineGateLike,
  findings: readonly NormalizedFindingEvidence[],
  selectSnippets: typeof selectReviewSnippets,
  readContext: typeof readPullRequestFileContext,
): Promise<{ readonly snippets: readonly ReviewSnippet[] } | undefined> {
  if (gate.verdict === "PASS") return undefined;
  const addedCandidates: SnippetCandidate[] = [];
  const contextCandidates: SnippetCandidate[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const line = finding.line;
    if (finding.category.toLowerCase() === "secrets" || !isSafeFindingFile(finding.file)
      || typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) continue;
    const key = `${finding.id}:${finding.file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = { key, file: finding.file, line };
    if (finding.addedInPullRequest) addedCandidates.push(candidate);
    else if (finding.changedInPullRequest) contextCandidates.push(candidate);
  }
  const diffSnippets = selectSnippets(snapshot.terraformDiff, addedCandidates);
  if (diffSnippets.length) return { snippets: diffSnippets };
  const snippets: ReviewSnippet[] = [];
  const readFiles = new Set<string>();
  for (const candidate of contextCandidates) {
    if (snippets.length === 2 || readFiles.has(candidate.file)) continue;
    readFiles.add(candidate.file);
    const context = await readContext(snapshot, candidate.file, candidate.line);
    if (!context) continue;
    const snippet = selectContextReviewSnippet(candidate, context);
    if (snippet) snippets.push(snippet);
  }
  return { snippets };
}

function normalizedFindingEvidence(result: { readonly findings: readonly NormalizedFindingEvidence[] }) {
  return result.findings;
}

export function classifyReviewFiles(snapshot: Pick<PullRequestSnapshot, "changedFiles">): ReviewFileCoverage {
  const terraform: string[] = [];
  const helmYamlJson: string[] = [];
  const documentation: string[] = [];
  const unsupported: string[] = [];
  for (const { path } of snapshot.changedFiles) {
    const lower = path.toLowerCase();
    if (/\.(?:tf|tfvars|hcl|tf\.json)$/.test(lower)) terraform.push(path);
    else if (/\.(?:yaml|yml|json|tpl|gotmpl)$/.test(lower) || /(?:^|\/)chart\.yaml$/.test(lower)) helmYamlJson.push(path);
    else if (/\.md$/.test(lower)) documentation.push(path);
    else unsupported.push(path);
  }
  return { terraform, helmYamlJson, documentation, unsupported };
}

function verdictRank(verdict: UnifiedVerdict): number {
  return ({ PASS: 0, WARN: 1, NEEDS_HUMAN: 2, BLOCK: 3 })[verdict];
}

export function buildUnifiedGate(
  gates: readonly EngineGateLike[],
  options: { readonly draft: boolean; readonly unsupportedFiles: number; readonly applicableEngines: number },
): EngineGateLike {
  const strongest = gates.reduce<UnifiedVerdict>((current, gate) =>
    verdictRank(gate.verdict) > verdictRank(current) ? gate.verdict : current, "PASS");
  const coverageGap = options.applicableEngines === 0 || options.unsupportedFiles > 0;
  const verdict: UnifiedVerdict = strongest === "BLOCK"
    ? "BLOCK"
    : strongest === "NEEDS_HUMAN" || options.draft || coverageGap
      ? "NEEDS_HUMAN"
      : strongest;
  return {
    verdict,
    reviewComplete: gates.every((gate) => gate.reviewComplete) && !coverageGap && !options.draft,
    mergeRecommended: verdict === "PASS" || verdict === "WARN",
    reasons: [
      ...gates.flatMap((gate) => gate.reasons),
      ...(options.draft ? ["The pull request is marked as draft."] : []),
      ...(options.applicableEngines === 0 ? ["No supported infrastructure file was available for deterministic review."] : []),
      ...(options.unsupportedFiles ? [`${options.unsupportedFiles} changed file(s) are outside deterministic Terraform/Helm/YAML/JSON coverage.`] : []),
    ].filter((reason, index, all) => all.indexOf(reason) === index),
  };
}

/** Primary single-PR entrypoint used by the OpenClaw tool adapter. */
export async function reviewUnifiedPullRequest(
  params: UnifiedPullRequestReviewParams,
  dependencies: UnifiedReviewDependencies = productionDependencies,
) {
  // Phase 1: prepare evidence once for classification and user-facing context.
  // The same immutable snapshot is passed to each applicable engine, avoiding
  // duplicate GitHub metadata reads, fetches, diffs and redaction in one run.
  const startedAt = Date.now();
  const snapshot = await dependencies.preparePullRequest(params.pullRequestUrl);
  const snapshotPreparedMs = Date.now() - startedAt;
  const intent = resolveReviewIntent(snapshot);
  const coverage = classifyReviewFiles(snapshot);
  const commits = snapshot.commits.slice(0, 20).map((commit) => commit.replace(/^[a-f0-9]{7,40}\s+/i, ""));
  const engines: Array<{ name: "terraform" | "helm-yaml-json"; result: TerraformReviewResult | GitOpsReviewResult }> = [];

  // Phase 2: invoke only engines whose deterministic file coverage applies.
  if (coverage.terraform.length) {
    engines.push({ name: "terraform", result: await dependencies.reviewTerraformPullRequest(params, { snapshot }) });
  }
  if (coverage.helmYamlJson.length) {
    engines.push({ name: "helm-yaml-json", result: await dependencies.reviewGitOpsPullRequest(params, { snapshot }) });
  }

  // Phase 3: the strongest engine verdict wins; draft or unsupported coverage
  // upgrades an otherwise safe result to NEEDS_HUMAN.
  const gate = buildUnifiedGate(
    engines.map(({ result }) => result.gate),
    {
      draft: snapshot.pullRequestContext?.draft === true,
      unsupportedFiles: coverage.unsupported.length,
      applicableEngines: engines.length,
    },
  );
  const expandedEvidence = await selectExpandedEvidence(
    snapshot,
    gate,
    engines.flatMap(({ result }) => normalizedFindingEvidence(result)),
    dependencies.selectReviewSnippets,
    dependencies.readPullRequestFileContext,
  );
  // Phase 4: return structured engine evidence separately from presentation
  // instructions so the host cannot accidentally hide safety limitations.
  return {
    repository: snapshot.repository,
    pullRequest: snapshot.pullRequest,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    pr: {
      title: snapshot.pullRequestContext?.title,
      state: snapshot.pullRequestContext?.state,
      draft: snapshot.pullRequestContext?.draft ?? false,
      labels: snapshot.pullRequestContext?.labels ?? [],
      contextSource: snapshot.pullRequestContext?.source ?? "git-only",
    },
    intent,
    changeSummary: {
      commits,
      changedFiles: snapshot.changedFiles.length,
      affectedComponents: intent.affectedComponents,
      environments: intent.environments,
      changedKeys: intent.changedKeys,
    },
    coverage: {
      ...coverage,
      engines: engines.map(({ name }) => name),
      diffTruncated: snapshot.diffTruncated,
    },
    engineResults: engines,
    gate,
    presentation: buildHumanFriendlyPresentation(gate),
    ...(expandedEvidence ? { expandedEvidence } : {}),
    performance: {
      snapshotPreparedMs,
      deterministicReviewMs: Date.now() - startedAt - snapshotPreparedMs,
      totalDeterministicMs: Date.now() - startedAt,
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
