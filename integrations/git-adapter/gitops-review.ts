/**
 * GitOps Review Engine for Helm, Kubernetes, Kustomize, YAML/JSON and Datadog
 * service-catalog changes. Base/head evidence is generated in temporary
 * snapshots with no cluster connection or apply capability.
 */
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitOpsReviewParams } from "@friday/shared";
import { capText, preparePullRequest, redact, type PullRequestSnapshot } from "./core.js";
import { reviewRuntime } from "./runtime-config.js";
import { parseAddedLinesFromUnifiedDiff } from "./review-policy.js";
import { classifyFindingRelevance, resolveReviewIntent, type FindingRelevance, type IntentSpec } from "./review-intent.js";
import {
  materializeChangedTerraformFiles,
  materializeSnapshot,
  normalizeReviewPath,
  parseTrivyJson,
  runFixedProcess,
  type ReviewCategory,
  type ReviewSeverity,
} from "./terraform-review.js";

const MAX_UNITS = 16;
const MAX_FINDINGS = 100;

export type GitOpsTool = "friday-gitops-policy" | "helm" | "kustomize" | "kubeconform" | "trivy";

export interface GitOpsFinding {
  readonly tool: GitOpsTool;
  readonly sources: readonly GitOpsTool[];
  readonly category: ReviewCategory;
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly file: string;
  readonly line?: number;
  readonly title: string;
  readonly message: string;
  readonly remediation?: string;
  readonly changedInPullRequest: boolean;
  readonly addedInPullRequest: boolean;
  readonly relevance?: FindingRelevance;
  readonly relevanceReason?: string;
}

interface HelmReviewUnit {
  readonly chart: string;
  readonly valuesFile?: string;
  readonly id: string;
}

interface RenderComparison {
  readonly unit: string;
  readonly status: "changed" | "unchanged" | "regression" | "baseline-failure" | "head-only";
  readonly baseRendered: boolean;
  readonly headRendered: boolean;
}

interface ConsumptionEvidence {
  readonly unit: string;
  readonly key: string;
  readonly status: "consumed" | "passthrough" | "unresolved";
  readonly templateFiles: readonly string[];
}

interface TargetValidation {
  readonly criterion: string;
  readonly status: "passed" | "failed" | "unknown";
  readonly evidence: string;
}

export interface GitOpsScannerStatus {
  readonly tool: GitOpsTool;
  readonly required: boolean;
  readonly status: "success" | "error" | "unavailable" | "skipped";
  readonly durationMs: number;
  readonly findings: number;
  readonly error?: string;
}

function safeText(value: unknown, maxBytes = 2_000): string {
  return capText(redact(String(value ?? "")).trim(), maxBytes).text;
}

function isGitOpsPath(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".json") || lower.endsWith(".tpl");
}

function isDatadogServiceCatalogPath(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith("/entity.datadog.yaml")
    || lower.endsWith("/entity.datadog.yml")
    || lower.endsWith(".datadog.yaml")
    || lower.endsWith(".datadog.yml");
}

function isDynamic(value: string): boolean {
  return /\{\{|\$\{|secretKeyRef|valueFrom|secretsmanager|parameterstore|externalSecret/i.test(value);
}

function policyFinding(
  file: string,
  line: number,
  addedLines: ReadonlySet<number>,
  id: string,
  severity: ReviewSeverity,
  category: ReviewCategory,
  title: string,
  message: string,
  remediation: string,
): GitOpsFinding {
  return {
    tool: "friday-gitops-policy",
    sources: ["friday-gitops-policy"],
    category,
    id,
    severity,
    file,
    line,
    title,
    message,
    remediation,
    changedInPullRequest: true,
    addedInPullRequest: addedLines.has(line),
  };
}

export function scanGitOpsPolicy(
  file: string,
  source: string,
  addedLines: ReadonlySet<number> = new Set(),
): GitOpsFinding[] {
  const findings: GitOpsFinding[] = [];
  const lines = source.split("\n");
  // Retain line positions while ignoring trailing YAML comments. Every finding
  // must have safe, stable file:line evidence for the Slack summary.
  const commentFree = lines.map((line) => line.replace(/\s+#.*$/, ""));
  for (let index = 0; index < commentFree.length; index += 1) {
    const text = commentFree[index] ?? "";
    const line = index + 1;
    // Phase 1: detect plaintext secret-like key/value pairs, allowing only
    // explicit dynamic references such as External Secrets or valueFrom.
    const directSecret = /^\s*-?\s*["']?([^:#\n]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[^:#\n]*)["']?\s*:\s*["']?([^"'\n]+)["']?\s*$/i.exec(text);
    const referenceOnlyKey = /(?:name|ref|arn|path|store|provider|enabled|mount|volume)\s*$/i.test(directSecret?.[1]?.trim() ?? "");
    if (directSecret && !referenceOnlyKey && !isDynamic(directSecret[2] ?? "")) {
      findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-SECRET-001", "CRITICAL", "secrets",
        "Secret-like field contains a literal value",
        "A password, token, key, or secret-like field contains a hardcoded value. The value is intentionally omitted.",
        "Move the value to External Secrets, Secrets Manager, SSM, or a Kubernetes Secret reference and rotate it if real."));
    }

    // Phase 2: detect multi-line Kubernetes env entries where `name` and
    // `value` are intentionally separate YAML keys.
    const envName = /^\s*-?\s*name\s*:\s*["']?([^"'\n]+)["']?\s*$/i.exec(text);
    if (envName && /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key/i.test(envName[1] ?? "")) {
      for (let next = index + 1; next < Math.min(lines.length, index + 6); next += 1) {
        const value = /^\s*value\s*:\s*["']?([^"'\n]+)["']?\s*$/i.exec(commentFree[next] ?? "");
        if (!value) continue;
        if (!isDynamic(value[1] ?? "")) {
          findings.push(policyFinding(file, next + 1, addedLines, "FRIDAY-GITOPS-SECRET-002", "CRITICAL", "secrets",
            "Sensitive environment variable uses a literal value",
            "A secret-like environment variable uses a plaintext literal. The value is intentionally omitted.",
            "Use valueFrom.secretKeyRef or an ExternalSecret-managed Kubernetes Secret."));
        }
        break;
      }
    }

    // Phase 3: apply non-secret workload safeguards that can regress a deploy
    // even when schema rendering still succeeds.
    if (/^\s*image\s*:\s*[^#\s]+(?::latest|:latest["']?)\s*$/i.test(text)) {
      findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-IMAGE-001", "HIGH", "reliability",
        "Mutable latest image tag",
        "The workload uses the mutable latest tag, so identical Git state can deploy different images.",
        "Pin an immutable image digest or a unique version tag."));
    }
    const unsafeBoolean = /^\s*(privileged|allowPrivilegeEscalation|hostNetwork|hostPID|hostIPC)\s*:\s*true\s*$/i.exec(text);
    if (unsafeBoolean) {
      findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-SECURITY-001", "HIGH", "identity",
        `Unsafe workload setting: ${unsafeBoolean[1]}`,
        "This setting expands container or pod privileges and increases host-compromise impact.",
        "Disable the setting unless a documented, narrowly scoped exception is required."));
    }
    if (/^\s*runAsNonRoot\s*:\s*false\s*$/i.test(text)) {
      findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-SECURITY-002", "HIGH", "identity",
        "Container may run as root",
        "The security context explicitly permits a root process.",
        "Set runAsNonRoot: true and define a non-root UID where the image requires it."));
    }
    if (/^\s*replicas\s*:\s*0\s*$/i.test(text)) {
      findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-RELIABILITY-001", "MEDIUM", "reliability",
        "Workload scaled to zero",
        "The desired replica count is zero and may make the service unavailable.",
        "Confirm this is intentional for the target environment or restore a non-zero replica count."));
    }
  }
  return findings;
}

/**
 * Deterministic, offline subset of Datadog Service Catalog v3 validation.
 *
 * Datadog's schema requires apiVersion, kind, metadata and metadata.name. The
 * owner and environment tag checks are Friday quality policy: optional in the
 * public schema, but required to make a production catalog entry actionable.
 */
export function scanDatadogServiceCatalogPolicy(
  file: string,
  source: string,
  addedLines: ReadonlySet<number> = new Set(),
): GitOpsFinding[] {
  if (!isDatadogServiceCatalogPath(file)) return [];

  const findings: GitOpsFinding[] = [];
  const lines = source.split("\n");
  const active = lines.map((text, index) => ({
    line: index + 1,
    text: text.replace(/\s+#.*$/, ""),
  })).filter(({ text }) => text.trim() && !/^\s*#/.test(text));
  const topLevel = (key: string) => active.find(({ text }) => new RegExp(`^${key}\\s*:`).test(text));
  const apiVersion = topLevel("apiVersion");
  const kind = topLevel("kind");
  const metadata = topLevel("metadata");
  const metadataIndex = metadata ? active.indexOf(metadata) : -1;
  const metadataEnd = metadataIndex < 0
    ? -1
    : active.findIndex((entry, index) => index > metadataIndex && /^\S/.test(entry.text));
  const metadataEntries = metadataIndex < 0
    ? []
    : active.slice(metadataIndex + 1, metadataEnd < 0 ? active.length : metadataEnd);
  const metadataName = metadataEntries.find(({ text }) => /^\s+name\s*:/.test(text));
  const owner = metadataEntries.find(({ text }) => /^\s+owner\s*:/.test(text));
  const anchorLine = metadataName?.line ?? metadata?.line ?? apiVersion?.line ?? 1;

  const valueOf = (entry: { readonly text: string } | undefined) =>
    entry?.text.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "") ?? "";

  if (!apiVersion || valueOf(apiVersion) !== "v3") {
    findings.push(policyFinding(file, apiVersion?.line ?? anchorLine, addedLines,
      "FRIDAY-DATADOG-SCHEMA-001", "HIGH", "correctness",
      "Datadog catalog apiVersion must be v3",
      "The catalog entry is missing apiVersion: v3 or declares a different schema version.",
      "Set the top-level apiVersion to v3."));
  }
  if (!kind || valueOf(kind) !== "service") {
    findings.push(policyFinding(file, kind?.line ?? anchorLine, addedLines,
      "FRIDAY-DATADOG-SCHEMA-002", "HIGH", "correctness",
      "Datadog catalog kind must be service",
      "This file is reviewed as a service entity but kind: service is missing or different.",
      "Set the top-level kind to service, or use the matching Datadog entity schema and filename convention."));
  }
  if (!metadata || !metadataName || !valueOf(metadataName)) {
    findings.push(policyFinding(file, anchorLine, addedLines,
      "FRIDAY-DATADOG-SCHEMA-003", "HIGH", "correctness",
      "Datadog catalog metadata.name is required",
      "The v3 entity schema requires a non-empty metadata.name.",
      "Add metadata.name and make it exactly match the Datadog APM service name."));
  }

  const activePlaceholder = active.find(({ text }) =>
    /\b(?:TEAM_HANDLE|CHANNEL_ID|REPO_NAME|RUNBOOK_URL|DOCS_URL|PXX+|YOUR_[A-Z0-9_]+)\b/.test(text));
  if (activePlaceholder) {
    findings.push(policyFinding(file, activePlaceholder.line, addedLines,
      "FRIDAY-DATADOG-PLACEHOLDER-001", "HIGH", "correctness",
      "Active Datadog catalog field still contains a template placeholder",
      "An uncommented catalog value is still a template placeholder and will not point to a real team, channel, repository, runbook, or integration.",
      "Replace the placeholder with the real value or remove the optional field before merge."));
  }

  if (!owner || !valueOf(owner)) {
    findings.push(policyFinding(file, anchorLine, addedLines,
      "FRIDAY-DATADOG-OWNER-001", "MEDIUM", "other",
      "Datadog catalog entry has no owner",
      "The entry is schema-valid without an owner, but incidents and service discovery cannot route responsibility to a Datadog team.",
      "Set metadata.owner to an existing Datadog Teams handle."));
  }

  const environment = /(?:^|\/)services-catalog\/(dev|develop|stg|stage|staging|prd|prod|production|qa|uat)(?:\/|$)/i.exec(file)?.[1]?.toLowerCase();
  const environmentAliases: Readonly<Record<string, readonly string[]>> = {
    dev: ["dev", "develop", "development"], develop: ["dev", "develop", "development"],
    stg: ["stg", "stage", "staging"], stage: ["stg", "stage", "staging"], staging: ["stg", "stage", "staging"],
    prd: ["prd", "prod", "production"], prod: ["prd", "prod", "production"], production: ["prd", "prod", "production"],
    qa: ["qa"], uat: ["uat"],
  };
  if (environment) {
    const envTag = metadataEntries.find(({ text }) => /^\s*-\s*["']?env\s*:/.test(text));
    const envValue = envTag?.text.match(/^\s*-\s*["']?env\s*:\s*([^\s"']+)/i)?.[1]?.toLowerCase();
    if (!envTag) {
      findings.push(policyFinding(file, anchorLine, addedLines,
        "FRIDAY-DATADOG-ENV-001", "MEDIUM", "other",
        "Datadog catalog entry has no environment tag",
        `The file is under the ${environment} catalog path but metadata.tags does not declare env:${environment}.`,
        `Add an environment tag under metadata.tags using one of: ${(environmentAliases[environment] ?? [environment]).map((value) => `env:${value}`).join(", ")}.`));
    } else if (envValue && !(environmentAliases[environment] ?? [environment]).includes(envValue)) {
      findings.push(policyFinding(file, envTag.line, addedLines,
        "FRIDAY-DATADOG-ENV-002", "HIGH", "correctness",
        "Datadog environment tag conflicts with the catalog path",
        `The file is stored under ${environment}, but its active environment tag is env:${envValue}.`,
        "Align metadata.tags with the environment represented by the file path."));
    }
  }
  return findings;
}

export function scanGitOpsInvariants(
  file: string,
  source: string,
  addedLines: ReadonlySet<number> = new Set(),
): GitOpsFinding[] {
  const values = new Map<string, { value: number; line: number }>();
  source.split("\n").forEach((text, index) => {
    const match = /^\s*(minReplicas|maxReplicas|replicas)\s*:\s*(\d+)\s*(?:#.*)?$/i.exec(text);
    if (match?.[1] && match[2]) values.set(match[1].toLowerCase(), { value: Number(match[2]), line: index + 1 });
  });
  const min = values.get("minreplicas");
  const max = values.get("maxreplicas");
  const desired = values.get("replicas");
  const findings: GitOpsFinding[] = [];
  if (min && max && min.value > max.value) {
    const line = addedLines.has(min.line) ? min.line : max.line;
    findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-HPA-001", "HIGH", "reliability",
      "HPA minimum replicas exceeds maximum replicas",
      `minReplicas (${min.value}) is greater than maxReplicas (${max.value}), so the autoscaling target is invalid.`,
      "Set minReplicas less than or equal to maxReplicas."));
  }
  if (min && max && desired && (desired.value < min.value || desired.value > max.value)) {
    const line = addedLines.has(desired.line) ? desired.line : addedLines.has(min.line) ? min.line : max.line;
    findings.push(policyFinding(file, line, addedLines, "FRIDAY-GITOPS-HPA-002", "MEDIUM", "reliability",
      "Desired replicas is outside the HPA range",
      `replicas (${desired.value}) is outside minReplicas/maxReplicas (${min.value}-${max.value}).`,
      "Align the initial replica count with the configured HPA range or document the controller behavior."));
  }
  return findings;
}

async function findAncestorWith(snapshotRoot: string, file: string, markers: readonly string[]): Promise<string | undefined> {
  let current = path.posix.dirname(file);
  while (current !== "." && current !== "/") {
    for (const marker of markers) {
      try {
        await access(path.join(snapshotRoot, current, marker));
        return current;
      } catch {
        // Continue to the parent.
      }
    }
    current = path.posix.dirname(current);
  }
  return undefined;
}

function addedTopLevelKeysByFile(diff: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let file = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1]) {
      file = normalizeReviewPath(header[1]);
      continue;
    }
    if (!file || !line.startsWith("+") || line.startsWith("+++")) continue;
    const match = /^\+([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (!match?.[1]) continue;
    const keys = result.get(file) ?? new Set<string>();
    keys.add(match[1]);
    result.set(file, keys);
  }
  return result;
}

async function templateFiles(root: string, relative = "", result: string[] = []): Promise<string[]> {
  if (result.length >= 512) return result;
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (result.length >= 512) break;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await templateFiles(root, child, result);
    else if (/\.(?:ya?ml|tpl|txt)$/i.test(entry.name)) result.push(child);
  }
  return result;
}

const HELM_PASSTHROUGH_KEYS = new Set([
  "affinity", "annotations", "args", "command", "env", "extraEnv", "fullnameOverride", "image",
  "imagePullSecrets", "nameOverride", "nodeSelector", "podAnnotations", "podLabels", "resources",
  "securityContext", "service", "serviceAccount", "tolerations", "topologySpreadConstraints",
]);

async function inspectValueConsumption(
  snapshotRoot: string,
  unit: HelmReviewUnit,
  keys: ReadonlySet<string>,
): Promise<{ evidence: ConsumptionEvidence[]; findings: GitOpsFinding[] }> {
  const evidence: ConsumptionEvidence[] = [];
  const findings: GitOpsFinding[] = [];
  const files = await templateFiles(path.join(snapshotRoot, unit.chart, "templates"));
  const sources: Array<{ file: string; text: string }> = [];
  const chartMetadata = await readFile(path.join(snapshotRoot, unit.chart, "Chart.yaml"), "utf8").catch(() => "");
  const dependencyKeys = new Set<string>();
  for (const match of chartMetadata.matchAll(/^\s*(?:name|alias)\s*:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/gm)) {
    if (match[1]) dependencyKeys.add(match[1]);
  }
  for (const file of files) {
    const fullPath = path.join(snapshotRoot, unit.chart, "templates", file);
    const statSafe = await readFile(fullPath, "utf8").catch(() => "");
    if (Buffer.byteLength(statSafe) <= 256 * 1024) sources.push({ file, text: statSafe });
  }
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`\\.Values(?:\\.${escaped}|\\[\\s*["']${escaped}["']\\s*\\])(?:\\b|\\s|[})|])`);
    const consumers = sources.filter(({ text }) => matcher.test(text)).map(({ file }) => path.posix.join(unit.chart, "templates", file));
    const passthrough = HELM_PASSTHROUGH_KEYS.has(key) || dependencyKeys.has(key);
    const status: ConsumptionEvidence["status"] = consumers.length ? "consumed" : passthrough ? "passthrough" : "unresolved";
    evidence.push({ unit: unit.id, key, status, templateFiles: consumers.slice(0, 12) });
    if (status === "unresolved") {
      findings.push(syntheticFinding(
        "helm",
        unit.valuesFile ?? unit.chart,
        "FRIDAY-GITOPS-CONSUMPTION-001",
        "HIGH",
        `Changed value '${key}' is not consumed by the chart templates`,
        "The value was added at the top level of a changed values file, but no direct .Values reference was found in this chart's templates.",
      ));
    }
  }
  return { evidence, findings };
}

function classifyFindings(findings: readonly GitOpsFinding[], intent: IntentSpec): GitOpsFinding[] {
  return findings.map((finding) => {
    const classified = classifyFindingRelevance(finding, intent);
    return { ...finding, relevance: classified.relevance, relevanceReason: classified.reason };
  });
}

function buildTargetValidation(
  intent: IntentSpec,
  findings: readonly GitOpsFinding[],
  comparisons: readonly RenderComparison[],
  consumption: readonly ConsumptionEvidence[],
  diff: string,
): TargetValidation[] {
  const targetBlockers = findings.filter((finding) => finding.relevance === "target" && ["CRITICAL", "HIGH"].includes(finding.severity));
  const newSecrets = findings.filter((finding) => finding.addedInPullRequest && finding.category === "secrets");
  const placementValues = [...new Set([...diff.matchAll(/^\+\s*(?:workerNodeGroup|nodegroup_type|node_selector)\s*:\s*["']?([^\s"'#{}]+)["']?/gmi)].map((match) => match[1]).filter(Boolean))];
  return intent.acceptanceCriteria.map((criterion) => {
    const lower = criterion.toLowerCase();
    if (lower.includes("consumed")) {
      const unresolved = consumption.filter((item) => item.status === "unresolved");
      return unresolved.length
        ? { criterion, status: "failed", evidence: `${unresolved.length} changed top-level value(s) are unresolved.` }
        : consumption.length
          ? { criterion, status: "passed", evidence: `${consumption.filter((item) => item.status === "consumed").length} value(s) are directly consumed; ${consumption.filter((item) => item.status === "passthrough").length} dependency/passthrough value(s) identified.` }
          : { criterion, status: "unknown", evidence: "No changed top-level Helm value was available for consumption tracing." };
    }
    if (lower.includes("render") || lower.includes("observability")) {
      const regressions = comparisons.filter((item) => item.status === "regression" || !item.headRendered);
      return regressions.length
        ? { criterion, status: "failed", evidence: `${regressions.length} target unit(s) failed base/head render comparison.` }
        : comparisons.length
          ? { criterion, status: "passed", evidence: `${comparisons.length} target unit(s) rendered at head; base/head comparison completed.` }
          : { criterion, status: "unknown", evidence: "No applicable rendered unit was produced." };
    }
    if (lower.includes("selector keys") || lower.includes("node-group")) {
      return placementValues.length === 1
        ? { criterion, status: "passed", evidence: `All directly changed placement selectors use the same value (${placementValues[0]}).` }
        : { criterion, status: "unknown", evidence: placementValues.length ? "Multiple placement values were changed and require topology context." : "No direct placement value could be extracted." };
    }
    if (lower.includes("taints") || lower.includes("capacity")) {
      return { criterion, status: "unknown", evidence: "Cluster access is disabled; live labels, taints, tolerations, and capacity were not queried." };
    }
    if (lower.includes("plaintext credential") || lower.includes("secret material")) {
      return newSecrets.length
        ? { criterion, status: "failed", evidence: `${newSecrets.length} new secret-related finding(s) are attributed to added lines.` }
        : { criterion, status: "passed", evidence: "No secret-related finding is attributed to an added PR line; existing findings remain baseline-only." };
    }
    if (lower.includes("minreplicas") || lower.includes("hpa")) {
      const hpaBlockers = targetBlockers.filter((finding) => finding.id.includes("HPA"));
      return hpaBlockers.length
        ? { criterion, status: "failed", evidence: `${hpaBlockers.length} target HPA invariant violation(s) found.` }
        : { criterion, status: "passed", evidence: "No target HPA invariant violation was found by deterministic policy." };
    }
    return targetBlockers.length
      ? { criterion, status: "failed", evidence: `${targetBlockers.length} target blocker(s) remain.` }
      : { criterion, status: "unknown", evidence: "No blocker was found, but this criterion needs domain or runtime evidence." };
  });
}

function syntheticFinding(
  tool: GitOpsTool,
  file: string,
  id: string,
  severity: ReviewSeverity,
  title: string,
  message: unknown,
  addedInPullRequest = true,
): GitOpsFinding {
  return {
    tool,
    sources: [tool],
    category: tool === "kubeconform" || tool === "helm" || tool === "kustomize" ? "correctness" : "other",
    id,
    severity,
    file,
    title,
    message: safeText(message),
    changedInPullRequest: true,
    addedInPullRequest,
  };
}

export function parseKubeconformJson(output: string, unit: string): GitOpsFinding[] {
  try {
    const document = JSON.parse(output) as { resources?: Array<Record<string, unknown>> };
    return (document.resources ?? []).flatMap((resource) => {
      const status = String(resource.status ?? "");
      if (status === "statusValid" || status === "statusSkipped") return [];
      const kind = safeText(resource.kind, 200) || "resource";
      const name = safeText(resource.name, 200);
      return [syntheticFinding(
        "kubeconform",
        unit,
        `KUBECONFORM-${status || "INVALID"}`,
        "HIGH",
        `Kubernetes schema validation failed for ${kind}${name ? `/${name}` : ""}`,
        safeText(resource.msg) || "Rendered Kubernetes resource failed schema validation.",
      )];
    });
  } catch (error) {
    return [syntheticFinding("kubeconform", unit, "KUBECONFORM-PARSE", "HIGH", "Kubeconform output could not be parsed", error)];
  }
}

function dedupe(findings: readonly GitOpsFinding[]): GitOpsFinding[] {
  const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  const result = new Map<string, GitOpsFinding>();
  for (const finding of findings) {
    const key = `${finding.category}:${finding.file}:${finding.line ?? 0}:${finding.title.toLowerCase()}`;
    const existing = result.get(key);
    if (!existing) result.set(key, finding);
    else result.set(key, { ...existing, sources: [...new Set([...existing.sources, ...finding.sources])] });
  }
  return [...result.values()].sort((left, right) =>
    severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity)
    || Number(right.addedInPullRequest) - Number(left.addedInPullRequest)
    || left.file.localeCompare(right.file)
    || (left.line ?? 0) - (right.line ?? 0));
}

function buildGate(findings: readonly GitOpsFinding[], tools: readonly GitOpsScannerStatus[], intent?: IntentSpec) {
  const targetBlocking = findings.filter((finding) => finding.addedInPullRequest
    && finding.relevance === "target" && ["CRITICAL", "HIGH"].includes(finding.severity));
  const crossCuttingBlocking = findings.filter((finding) => finding.addedInPullRequest
    && finding.relevance === "cross-cutting" && ["CRITICAL", "HIGH"].includes(finding.severity)
    && ["secrets", "identity"].includes(finding.category));
  const blocking = [...targetBlocking, ...crossCuttingBlocking];
  const incomplete = tools.filter((tool) => tool.required && tool.status !== "success");
  const lowIntentConfidence = intent?.confidence === "low";
  const verdict = blocking.length ? "BLOCK" : incomplete.length || lowIntentConfidence ? "NEEDS_HUMAN" : findings.length ? "WARN" : "PASS";
  return {
    verdict,
    reviewComplete: incomplete.length === 0 && !lowIntentConfidence,
    mergeRecommended: verdict === "PASS" || verdict === "WARN",
    blockingFindingIds: blocking.map((finding) => `${finding.id}:${finding.file}:${finding.line ?? 0}`),
    reasons: [
      ...(targetBlocking.length ? [`${targetBlocking.length} Critical/High finding(s) block the inferred PR objective.`] : []),
      ...(crossCuttingBlocking.length ? [`${crossCuttingBlocking.length} new security finding(s) block merge across all review targets.`] : []),
      ...(incomplete.length ? [`Required coverage incomplete: ${incomplete.map((tool) => tool.tool).join(", ")}.`] : []),
      ...(lowIntentConfidence ? ["PR intent confidence is low; human confirmation of the target and acceptance criteria is required."] : []),
      ...(!blocking.length && !incomplete.length && findings.length ? [`${findings.length} non-blocking finding(s) require review.`] : []),
      ...(!findings.length && !incomplete.length ? ["All applicable scanners completed with no findings."] : []),
    ],
  } as const;
}

/** Runs all applicable GitOps validators and returns target-aware findings. */
export async function reviewGitOpsPullRequest(
  params: GitOpsReviewParams,
  { snapshot: preparedSnapshot }: { readonly snapshot?: PullRequestSnapshot } = {},
) {
  // Phase 1: derive intent, applicable files, added lines and changed values
  // from the common redacted PR snapshot.
  const runtime = reviewRuntime();
  const { helm, kustomize, kubeconform, trivy } = runtime.binaries;
  const trivyCache = path.join(runtime.storage.cacheDir, "trivy");
  const kubeconformCache = path.join(runtime.storage.cacheDir, "kubeconform");
  // When routed through Unified Review, reuse its validated snapshot instead
  // of repeating the expensive bounded Git/GitHub preparation phase.
  const snapshot = preparedSnapshot ?? await preparePullRequest(params.pullRequestUrl);
  const intent = resolveReviewIntent(snapshot);
  const changedFiles = new Set(snapshot.changedFiles.map((entry) => normalizeReviewPath(entry.path)).filter(isGitOpsPath));
  const addedLines = parseAddedLinesFromUnifiedDiff(snapshot.terraformDiff);
  const addedKeys = addedTopLevelKeysByFile(snapshot.terraformDiff);
  // No GitOps files means explicit skipped coverage rather than false findings.
  if (!changedFiles.size) {
    const tools: GitOpsScannerStatus[] = [
      { tool: "friday-gitops-policy", required: false, status: "skipped", durationMs: 0, findings: 0 },
      { tool: "helm", required: false, status: "skipped", durationMs: 0, findings: 0 },
      { tool: "kustomize", required: false, status: "skipped", durationMs: 0, findings: 0 },
      { tool: "kubeconform", required: false, status: "skipped", durationMs: 0, findings: 0 },
      { tool: "trivy", required: false, status: "skipped", durationMs: 0, findings: 0 },
    ];
    return { repository: snapshot.repository, pullRequest: snapshot.pullRequest, headSha: snapshot.headSha, intent, summary: { status: "pass", changedGitOpsFiles: 0, findings: 0 }, findings: [], tools, gate: buildGate([], tools, intent) };
  }

  // Phase 2: create isolated head/base trees for safe render comparison.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "friday-gitops-review-"));
  await chmod(tempRoot, 0o700);
  const snapshotRoot = path.join(tempRoot, "snapshot");
  try {
    await materializeSnapshot(snapshot, snapshotRoot);
    const copiedRoot = path.join(tempRoot, "changed");
    const copied = await materializeChangedTerraformFiles(snapshotRoot, copiedRoot, changedFiles);
    await mkdir(trivyCache, { recursive: true, mode: 0o700 });
    await mkdir(kubeconformCache, { recursive: true, mode: 0o700 });
    // Phase 3: run source-level policy and discover the bounded set of Helm,
    // Kustomize and raw-manifest validation units affected by this PR.
    const helmUnits = new Map<string, HelmReviewUnit>();
    const kustomRoots = new Set<string>();
    const rawManifests: string[] = [];
    const policyStarted = Date.now();
    const policyFindings: GitOpsFinding[] = [];
    for (const file of copied) {
      const source = await readFile(path.join(snapshotRoot, file), "utf8");
      policyFindings.push(...scanGitOpsPolicy(file, source, addedLines.get(file) ?? new Set()));
      policyFindings.push(...scanGitOpsInvariants(file, source, addedLines.get(file) ?? new Set()));
      policyFindings.push(...scanDatadogServiceCatalogPolicy(file, source, addedLines.get(file) ?? new Set()));
      const chart = await findAncestorWith(snapshotRoot, file, ["Chart.yaml"]);
      const kustom = await findAncestorWith(snapshotRoot, file, ["kustomization.yaml", "kustomization.yml", "Kustomization"]);
      if (chart) {
        const isValuesFile = /(?:^|\/)values(?:\/|[^/]*\.ya?ml$)/i.test(file) && /\.ya?ml$/i.test(file);
        const unit: HelmReviewUnit = isValuesFile
          ? { chart, valuesFile: file, id: file }
          : { chart, id: chart };
        helmUnits.set(unit.id, unit);
      }
      else if (kustom) kustomRoots.add(kustom);
      else if (!isDatadogServiceCatalogPath(file) && /^\s*apiVersion\s*:/m.test(source) && /^\s*kind\s*:/m.test(source)) rawManifests.push(file);
    }
    const selectedHelmUnits = [...helmUnits.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, MAX_UNITS);
    const selectedCharts = [...new Set(selectedHelmUnits.map((unit) => unit.chart))];
    const selectedKustom = [...kustomRoots].sort().slice(0, MAX_UNITS);
    // Materialize the base revision only when renderer comparison is required.
    const baseRoot = path.join(tempRoot, "base-snapshot");
    if (selectedHelmUnits.length || selectedKustom.length) {
      await materializeSnapshot({ ...snapshot, headSha: snapshot.baseSha }, baseRoot);
    }
    const findings: GitOpsFinding[] = [...policyFindings];
    const tools: GitOpsScannerStatus[] = [{
      tool: "friday-gitops-policy", required: true, status: "success", durationMs: Date.now() - policyStarted, findings: policyFindings.length,
    }];

    // Phase 4: lint/render Helm head and base with fixed Kubernetes version,
    // recording regressions separately from failures already in the baseline.
    const helmAvailable = await access(helm).then(() => true).catch(() => false);
    const rendered: Array<{ unit: string; file: string }> = [];
    const renderComparisons: RenderComparison[] = [];
    const consumptionEvidence: ConsumptionEvidence[] = [];
    const helmStarted = Date.now();
    let helmError = "";
    for (const [index, unit] of selectedHelmUnits.entries()) {
      if (!helmAvailable) break;
      const chartPath = path.join(snapshotRoot, unit.chart);
      const baseChartPath = path.join(baseRoot, unit.chart);
      const headValues = unit.valuesFile ? path.join(snapshotRoot, unit.valuesFile) : undefined;
      const baseValues = unit.valuesFile ? path.join(baseRoot, unit.valuesFile) : undefined;
      const valuesArgs = headValues ? ["-f", headValues] : [];
      const baseValuesArgs = baseValues ? ["-f", baseValues] : [];
      const baseExists = await access(baseChartPath).then(() => true).catch(() => false);
      const baseValuesExist = !baseValues || await access(baseValues).then(() => true).catch(() => false);
      const baseRunnable = baseExists && baseValuesExist;

      const keys = unit.valuesFile ? addedKeys.get(unit.valuesFile) ?? new Set<string>() : new Set<string>();
      if (keys.size) {
        const consumption = await inspectValueConsumption(snapshotRoot, unit, keys);
        consumptionEvidence.push(...consumption.evidence);
        findings.push(...consumption.findings);
      }

      const lint = await runFixedProcess(helm, ["lint", chartPath, "--quiet", "--kube-version", "1.30.0", ...valuesArgs], snapshotRoot);
      const baseLint = baseRunnable
        ? await runFixedProcess(helm, ["lint", baseChartPath, "--quiet", "--kube-version", "1.30.0", ...baseValuesArgs], baseRoot)
        : undefined;
      if (lint.exitCode !== 0) {
        helmError ||= safeText(lint.stderr || lint.stdout || "Helm lint failed.");
        const baselineFailure = baseLint !== undefined && baseLint.exitCode !== 0;
        findings.push(syntheticFinding(
          "helm",
          unit.id,
          baselineFailure ? "HELM-LINT-BASELINE" : "HELM-LINT",
          baselineFailure ? "MEDIUM" : "HIGH",
          baselineFailure ? "Helm lint failure already exists in the base revision" : "Helm lint failed after the PR change",
          lint.stderr || lint.stdout,
          !baselineFailure,
        ));
        renderComparisons.push({ unit: unit.id, status: baselineFailure ? "baseline-failure" : "regression", baseRendered: false, headRendered: false });
        continue;
      }
      const template = await runFixedProcess(helm, ["template", "friday-review", chartPath, "--include-crds", "--skip-tests", "--kube-version", "1.30.0", ...valuesArgs], snapshotRoot);
      const baseTemplate = baseRunnable
        ? await runFixedProcess(helm, ["template", "friday-review", baseChartPath, "--include-crds", "--skip-tests", "--kube-version", "1.30.0", ...baseValuesArgs], baseRoot)
        : undefined;
      if (template.exitCode !== 0 || !template.stdout.trim()) {
        helmError ||= safeText(template.stderr || "Helm produced no rendered manifest.");
        const baselineFailure = baseTemplate !== undefined && (baseTemplate.exitCode !== 0 || !baseTemplate.stdout.trim());
        findings.push(syntheticFinding(
          "helm", unit.id, baselineFailure ? "HELM-TEMPLATE-BASELINE" : "HELM-TEMPLATE",
          baselineFailure ? "MEDIUM" : "HIGH",
          baselineFailure ? "Helm render failure already exists in the base revision" : "Helm template rendering failed after the PR change",
          template.stderr || "No rendered manifest.", !baselineFailure,
        ));
        renderComparisons.push({ unit: unit.id, status: baselineFailure ? "baseline-failure" : "regression", baseRendered: false, headRendered: false });
        continue;
      }
      const renderedFile = path.join(tempRoot, `helm-${index}.yaml`);
      await writeFile(renderedFile, template.stdout, { mode: 0o600 });
      rendered.push({ unit: unit.id, file: renderedFile });
      const baseRendered = Boolean(baseTemplate && baseTemplate.exitCode === 0 && baseTemplate.stdout.trim());
      renderComparisons.push({
        unit: unit.id,
        status: !baseTemplate ? "head-only" : !baseRendered ? "regression" : baseTemplate.stdout === template.stdout ? "unchanged" : "changed",
        baseRendered,
        headRendered: true,
      });
    }
    tools.push({
      tool: "helm", required: selectedHelmUnits.length > 0,
      status: !selectedHelmUnits.length ? "skipped" : !helmAvailable ? "unavailable" : helmError ? "error" : "success",
      durationMs: Date.now() - helmStarted,
      findings: findings.filter((finding) => finding.tool === "helm").length,
      ...(helmError ? { error: helmError } : {}),
    });

    // Phase 5: render Kustomize with root-only load restrictions so overlays
    // cannot read arbitrary paths outside the snapshot.
    const kustomizeAvailable = await access(kustomize).then(() => true).catch(() => false);
    const kustomStarted = Date.now();
    let kustomError = "";
    for (const [index, unit] of selectedKustom.entries()) {
      if (!kustomizeAvailable) break;
      const result = await runFixedProcess(kustomize, ["build", path.join(snapshotRoot, unit), "--load-restrictor", "LoadRestrictionsRootOnly"], snapshotRoot);
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        kustomError ||= safeText(result.stderr || "Kustomize build failed.");
        findings.push(syntheticFinding("kustomize", unit, "KUSTOMIZE-BUILD", "HIGH", "Kustomize build failed", result.stderr));
        continue;
      }
      const renderedFile = path.join(tempRoot, `kustomize-${index}.yaml`);
      await writeFile(renderedFile, result.stdout, { mode: 0o600 });
      rendered.push({ unit, file: renderedFile });
    }
    tools.push({
      tool: "kustomize", required: selectedKustom.length > 0,
      status: !selectedKustom.length ? "skipped" : !kustomizeAvailable ? "unavailable" : kustomError ? "error" : "success",
      durationMs: Date.now() - kustomStarted,
      findings: findings.filter((finding) => finding.tool === "kustomize").length,
      ...(kustomError ? { error: kustomError } : {}),
    });

    // Phase 6: validate every successfully rendered/raw manifest offline. An
    // upstream renderer failure remains visible as incomplete required coverage.
    for (const file of rawManifests) rendered.push({ unit: file, file: path.join(snapshotRoot, file) });
    const kubeconformAvailable = await access(kubeconform).then(() => true).catch(() => false);
    const kubeStarted = Date.now();
    let kubeError = "";
    if (kubeconformAvailable) {
      for (const unit of rendered) {
        const result = await runFixedProcess(kubeconform, ["-output", "json", "-strict", "-ignore-missing-schemas", "-kubernetes-version", "1.30.0", "-cache", kubeconformCache, unit.file], tempRoot);
        if (result.exitCode !== 0) kubeError ||= safeText(result.stderr || "Kubeconform failed.");
        if (result.stdout) findings.push(...parseKubeconformJson(result.stdout, unit.unit));
      }
    }
    const kubeRequired = rendered.length > 0 || (selectedCharts.length > 0 && Boolean(helmError)) || (selectedKustom.length > 0 && Boolean(kustomError));
    if (kubeRequired && rendered.length === 0 && !kubeError) kubeError = "No rendered manifest was available because the upstream renderer failed.";
    tools.push({
      tool: "kubeconform", required: kubeRequired,
      status: !kubeRequired ? "skipped" : !kubeconformAvailable ? "unavailable" : kubeError ? "error" : "success",
      durationMs: Date.now() - kubeStarted,
      findings: findings.filter((finding) => finding.tool === "kubeconform").length,
      ...(kubeError ? { error: kubeError } : {}),
    });

    // Phase 7: scan only the copied changed-file tree with updates/network use
    // disabled, then discard findings outside the PR file set.
    const trivyAvailable = await access(trivy).then(() => true).catch(() => false);
    const trivyStarted = Date.now();
    let trivyError = "";
    if (trivyAvailable) {
      const result = await runFixedProcess(trivy, ["filesystem", "--format=json", "--quiet", "--scanners=misconfig,secret", "--misconfig-scanners=helm,kubernetes", "--skip-check-update", "--skip-version-check", "--offline-scan", "--timeout=2m", `--cache-dir=${trivyCache}`, copiedRoot], copiedRoot);
      trivyError = result.exitCode !== 0 ? safeText(result.stderr || `Trivy exited with code ${result.exitCode}.`) : "";
      if (result.stdout) {
        const parsed = parseTrivyJson(result.stdout, copiedRoot);
        trivyError ||= parsed.parseError ?? "";
        for (const item of parsed.findings) {
          const file = normalizeReviewPath(item.file);
          if (!changedFiles.has(file)) continue;
          findings.push({
            tool: "trivy", sources: ["trivy"], category: item.category, id: item.id, severity: item.severity,
            file, ...(item.line === undefined ? {} : { line: item.line }), title: item.title, message: item.message,
            ...(item.remediation ? { remediation: item.remediation } : {}), changedInPullRequest: true,
            addedInPullRequest: item.line !== undefined && (addedLines.get(file)?.has(item.line) ?? false),
          });
        }
      }
      tools.push({ tool: "trivy", required: true, status: trivyError ? "error" : "success", durationMs: Date.now() - trivyStarted, findings: findings.filter((finding) => finding.tool === "trivy").length, ...(trivyError ? { error: trivyError } : {}) });
    } else {
      tools.push({ tool: "trivy", required: true, status: "unavailable", durationMs: 0, findings: 0 });
    }

    // Phase 8: deduplicate, classify against PR intent, cap output and construct
    // the fail-closed gate plus human-facing evidence buckets.
    const deduplicated = classifyFindings(dedupe(findings), intent);
    const limited = deduplicated.slice(0, MAX_FINDINGS);
    const targetFindings = limited.filter((finding) => finding.relevance === "target");
    const crossCuttingFindings = limited.filter((finding) => finding.relevance === "cross-cutting");
    const baselineFindings = limited.filter((finding) => finding.relevance === "baseline");
    const gate = buildGate(limited, tools, intent);
    return {
      repository: snapshot.repository,
      pullRequest: snapshot.pullRequest,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      intent,
      summary: {
        status: gate.verdict === "NEEDS_HUMAN" ? "partial" : limited.length ? "findings" : "pass",
        changedGitOpsFiles: changedFiles.size,
        helmCharts: selectedCharts,
        kustomizeUnits: selectedKustom,
        findings: limited.length,
        targetFindings: targetFindings.length,
        crossCuttingFindings: crossCuttingFindings.length,
        baselineFindings: baselineFindings.length,
        addedLineFindings: limited.filter((finding) => finding.addedInPullRequest).length,
        truncated: deduplicated.length > MAX_FINDINGS,
      },
      findings: limited,
      targetFindings,
      crossCuttingFindings,
      baselineFindings,
      targetValidation: buildTargetValidation(intent, limited, renderComparisons, consumptionEvidence, snapshot.terraformDiff),
      renderComparisons,
      consumptionEvidence,
      tools,
      gate,
      presentation: {
        format: "friday-target-aware-review-v3",
        requiredSections: ["PR intent", "Target validation", "Target blockers", "Cross-cutting findings", "Baseline findings", "Unknowns", "Verdict"],
        discloseSecretValues: false,
      },
      safety: {
        workingTreeChanged: false,
        pushedRemoteChanges: false,
        clusterConnected: false,
        deploymentApplied: false,
        scannerUpdates: false,
        secretsRedacted: true,
        temporarySnapshotRemoved: true,
      },
    };
  } finally {
    // Head/base render trees may contain private source and are always removed.
    await rm(tempRoot, { recursive: true, force: true });
  }
}
