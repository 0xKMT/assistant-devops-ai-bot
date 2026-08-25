/**
 * Derives the PR objective and classifies findings against that objective.
 * Metadata is treated as untrusted evidence and redacted before it becomes
 * review context.
 */
import { redact, type PullRequestSnapshot } from "./core.js";

export type ReviewDomain =
  | "node-placement"
  | "autoscaling"
  | "secret-management"
  | "image-release"
  | "networking"
  | "observability"
  | "service-catalog"
  | "configuration";

export interface IntentSpec {
  readonly objective: string;
  readonly domains: readonly ReviewDomain[];
  readonly affectedComponents: readonly string[];
  readonly environments: readonly string[];
  readonly changedKeys: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly confidence: "high" | "medium" | "low";
  readonly evidence: readonly string[];
  readonly contextSummary: {
    readonly source: "github-cli-oauth-broker" | "git-only";
    readonly titleAvailable: boolean;
    readonly commentCount: number;
    readonly reviewStates: readonly string[];
    readonly labels: readonly string[];
  };
  readonly reviewSignals: readonly string[];
  readonly unknowns: readonly string[];
}

export type FindingRelevance = "target" | "cross-cutting" | "baseline";

function unique(values: readonly string[], limit = 40): string[] {
  // All intent fields are returned to the model, so deduplicate and bound them
  // before external PR metadata can grow the prompt without limit.
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function objectiveFromCommits(commits: readonly string[]): string {
  const subjects = commits.slice(0, 3).map((commit) => commit.replace(/^[a-f0-9]{7,40}\s+/i, "").trim()).filter(Boolean);
  return redact(subjects.join("; ") || "Review the changed configuration and verify its intended behavior.");
}

function explicitCriteria(body: string): string[] {
  const criteria: string[] = [];
  for (const line of body.split("\n")) {
    const checklist = /^\s*[-*]\s*\[[ xX]\]\s+(.{3,300})$/.exec(line);
    if (checklist?.[1]) criteria.push(redact(checklist[1].trim()));
    const acceptance = /^\s*(?:acceptance criteria|expected behavior|expected result)\s*:\s*(.{3,300})$/i.exec(line);
    if (acceptance?.[1]) criteria.push(redact(acceptance[1].trim()));
  }
  return unique(criteria, 10);
}

function changedKeysFromDiff(diff: string): string[] {
  const keys: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const match = /^\+\s*-?\s*["']?([A-Za-z0-9_.-]+)["']?\s*:/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return unique(keys);
}

function affectedComponents(snapshot: PullRequestSnapshot): string[] {
  return unique(snapshot.changedFiles.map(({ path }) => {
    const parts = path.split("/");
    if (parts[0] === "chart" && (parts[1] === "service" || parts[1] === "tool")) return `${parts[1]}/${parts[2] ?? "unknown"}`;
    if (parts[0] === "modules") return `module/${parts[1] ?? "unknown"}`;
    return parts.slice(0, 2).join("/");
  }), 30);
}

function environments(snapshot: PullRequestSnapshot): string[] {
  const found: string[] = [];
  for (const { path } of snapshot.changedFiles) {
    const match = /(?:^|\/)(?:values|environments?|services-catalog)\/(dev|develop|stg|stage|staging|prd|prod|production|qa|uat)(?:\/|\.)/i.exec(path);
    if (match?.[1]) found.push(match[1].toLowerCase());
  }
  return unique(found, 10);
}

function detectDomains(text: string, keys: readonly string[]): ReviewDomain[] {
  // This is intentionally a transparent heuristic, not an LLM classifier:
  // each matched domain selects deterministic acceptance criteria below.
  const input = `${text} ${keys.join(" ")}`.toLowerCase();
  const domains: ReviewDomain[] = [];
  const serviceCatalog = /datadog|service.?catalog|entity\.datadog/.test(input);
  if (serviceCatalog) return ["service-catalog"];
  if (/node.?selector|node.?group|workernodegroup|toleration|affinity|topology|schedule/.test(input)) domains.push("node-placement");
  if (/hpa|autoscal|minreplica|maxreplica|replicas|scale.?in|scale.?out|cooldown/.test(input)) domains.push("autoscaling");
  if (/secret|password|credential|token|auth|webhook|api.?key/.test(input)) domains.push("secret-management");
  if (/image|digest|release/.test(input) || (!serviceCatalog && /\b(?:tag|version)\b/.test(input))) domains.push("image-release");
  if (/ingress|gateway|virtualservice|serviceport|targetport|network|cidr|loadbalancer/.test(input)) domains.push("networking");
  if (/monitor|metric|prometheus|grafana|otel|opentelemetry|kiali|log|trace/.test(input)) domains.push("observability");
  return domains.length ? unique(domains) as ReviewDomain[] : ["configuration"];
}

function criteriaFor(domains: readonly ReviewDomain[]): string[] {
  const criteria: string[] = [];
  if (domains.includes("node-placement")) criteria.push(
    "Changed placement values are consumed by the intended templates.",
    "Base/head rendering produces the expected nodeSelector without breaking workloads.",
    "Selector keys and node-group values are consistent across affected components.",
    "Taints, tolerations, affinity, and scheduling capacity remain explicit unknowns when cluster data is unavailable.",
  );
  if (domains.includes("autoscaling")) criteria.push(
    "minReplicas does not exceed maxReplicas and desired replicas remain compatible with autoscaling.",
    "The HPA target and scaling behavior are valid for the affected workload.",
  );
  if (domains.includes("secret-management")) criteria.push("No new plaintext credential or secret material is introduced.");
  if (domains.includes("image-release")) criteria.push("Images use an immutable version or digest and render into the intended workload.");
  if (domains.includes("networking")) criteria.push("Rendered routes, ports, gateways, and exposure match the intended environment.");
  if (domains.includes("observability")) criteria.push("Observability components render successfully and preserve collection/availability behavior.");
  if (domains.includes("service-catalog")) criteria.push(
    "Datadog Service Catalog v3 required fields are present and valid.",
    "Catalog ownership and environment metadata are explicit and contain no active template placeholders.",
  );
  if (!criteria.length) criteria.push("Changed values are consumed and all applicable render/schema checks complete successfully.");
  return unique(criteria, 12);
}

/** Produces a bounded intent model from title, body, commits and changed keys. */
export function resolveReviewIntent(snapshot: PullRequestSnapshot): IntentSpec {
  // Phase 1: collect bounded, redacted evidence. PR metadata remains untrusted
  // evidence; it describes the intended change but cannot change review policy.
  const context = snapshot.pullRequestContext;
  const title = context?.title?.trim();
  const body = context?.bodySummary ?? "";
  const objective = redact(title || objectiveFromCommits(snapshot.commits));
  const changedKeys = changedKeysFromDiff(snapshot.terraformDiff);
  const contextualText = [
    objective,
    body,
    ...snapshot.changedFiles.map(({ path }) => path),
    ...(context?.comments ?? []),
    ...((context?.reviews ?? []).map((review) => review.summary ?? "")),
  ].join(" ");
  const domains = detectDomains(contextualText, changedKeys);
  const components = affectedComponents(snapshot);
  const envs = environments(snapshot);

  // Phase 2: state confidence conservatively. A title alone is not sufficient;
  // Friday also needs either a recognized domain or concrete changed keys.
  const recognized = !domains.includes("configuration");
  const descriptiveCommit = snapshot.commits.some((commit) => /\b(feat|fix|refactor|chore|perf|deploy)(?:\([^)]*\))?:/i.test(commit));
  const explicit = explicitCriteria(body);
  const confidence: IntentSpec["confidence"] = Boolean(title) && (recognized || changedKeys.length > 0)
    ? "high"
    : recognized && descriptiveCommit && changedKeys.length > 0
      ? "high"
      : recognized || (descriptiveCommit && changedKeys.length > 0)
      ? "medium"
      : "low";
  return {
    objective,
    domains,
    affectedComponents: components,
    environments: envs,
    changedKeys,
    acceptanceCriteria: unique([...explicit, ...criteriaFor(domains)], 16),
    confidence,
    evidence: [
      `${snapshot.commits.length} commit subject(s)`,
      `${snapshot.changedFiles.length} changed file(s)`,
      `${changedKeys.length} added configuration key(s)`,
      ...(title ? ["PR title"] : []),
      ...(body ? ["PR body"] : []),
      ...(context?.comments.length ? [`${context.comments.length} PR comment(s)`] : []),
      ...(context?.reviews.length ? [`${context.reviews.length} PR review(s)`] : []),
    ],
    contextSummary: {
      source: context?.source ?? "git-only",
      titleAvailable: Boolean(title),
      commentCount: context?.comments.length ?? 0,
      reviewStates: unique((context?.reviews ?? []).map((review) => review.state), 10),
      labels: context?.labels ?? [],
    },
    reviewSignals: unique([
      ...(context?.comments ?? []).map((comment) => `Comment: ${comment}`),
      ...(context?.reviews ?? []).map((review) => `Review ${review.state}: ${review.summary || "no written summary"}`),
    ], 12),
    unknowns: [
      ...(context?.source !== "github-cli-oauth-broker" ? [context?.unavailableReason ?? "GitHub PR title/body/comments/reviews are unavailable; intent falls back to commits and diff."] : []),
      ...(domains.includes("node-placement") ? ["Live node labels, taints, and capacity are unavailable because cluster access is disabled."] : []),
    ],
  };
}

export function classifyFindingRelevance(
  finding: { readonly id: string; readonly title: string; readonly category: string; readonly addedInPullRequest: boolean },
  intent: IntentSpec,
): { relevance: FindingRelevance; reason: string } {
  // Phase 1: never attribute an unchanged-line finding to the PR. This keeps
  // baseline remediation visible without letting it distort the PR verdict.
  if (!finding.addedInPullRequest) return { relevance: "baseline", reason: "The finding is not attributed to an added PR line or new base/head regression." };
  // Phase 2: classify added-line evidence against the inferred objective; any
  // important but unrelated issue remains cross-cutting rather than blocking.
  const text = `${finding.id} ${finding.title}`.toLowerCase();
  if (/helm|kustomize|kubeconform|consumption|render/.test(text)) {
    return { relevance: "target", reason: "The finding affects rendering or validation of a changed target unit." };
  }
  if (intent.domains.includes("service-catalog") && /datadog|catalog/.test(text)) {
    return { relevance: "target", reason: "The finding directly affects the Datadog Service Catalog objective." };
  }
  if (intent.domains.includes("node-placement") && /node|selector|schedule|toleration|affinity|topology/.test(text)) {
    return { relevance: "target", reason: "The finding directly affects the node-placement objective." };
  }
  if (intent.domains.includes("autoscaling") && /hpa|replica|scale|cooldown|metric/.test(text)) {
    return { relevance: "target", reason: "The finding directly affects the autoscaling objective." };
  }
  if (intent.domains.includes("secret-management") && finding.category === "secrets") {
    return { relevance: "target", reason: "Secret handling is part of the inferred PR objective." };
  }
  return { relevance: "cross-cutting", reason: "The finding is important but is not direct evidence for the inferred PR objective." };
}
