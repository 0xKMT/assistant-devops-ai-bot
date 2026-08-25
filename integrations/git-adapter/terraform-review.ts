/**
 * Terraform Review Engine: materializes an isolated snapshot, runs fixed local
 * scanners, normalizes findings and returns a fail-closed gate. It never runs
 * Terraform init/plan/apply or scanner updates.
 */
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TerraformReviewParams } from "@friday/shared";
import {
  capText,
  preparePullRequest,
  redact,
  repositoryGitCachePath,
  runCommand,
  type PullRequestSnapshot,
} from "./core.js";
import { commandRunner } from "./process-runner.js";
import { resolveConfiguredRepository, reviewRuntime } from "./runtime-config.js";
import {
  annotateFinding,
  buildReviewGate,
  categorizeFinding,
  deduplicateFindings,
  parseAddedLinesFromUnifiedDiff,
  scanFridayTerraformPolicy,
} from "./review-policy.js";

const MAX_PROCESS_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS = 100;
const SCANNER_TIMEOUT_MS = 120_000;

export type ReviewSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type ReviewTool = "friday-policy" | "tflint" | "trivy";
export type ReviewCategory =
  | "secrets"
  | "identity"
  | "encryption"
  | "network"
  | "reliability"
  | "cost"
  | "correctness"
  | "other";

export interface TerraformFinding {
  readonly tool: ReviewTool;
  readonly sources: readonly ReviewTool[];
  readonly category: ReviewCategory;
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly file: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly title: string;
  readonly message: string;
  readonly remediation?: string;
  readonly reference?: string;
  readonly changedInPullRequest: boolean;
  readonly addedInPullRequest: boolean;
}

export interface ScannerStatus {
  readonly tool: ReviewTool;
  readonly status: "success" | "error" | "unavailable" | "skipped";
  readonly durationMs: number;
  readonly rawFindings: number;
  readonly changedFileFindings: number;
  readonly addedLineFindings: number;
  readonly error?: string;
}

export interface ReviewGate {
  readonly verdict: "BLOCK" | "NEEDS_HUMAN" | "WARN" | "PASS";
  readonly reviewComplete: boolean;
  readonly mergeRecommended: boolean;
  readonly blockingFindingIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface ParsedScanner {
  readonly findings: TerraformFinding[];
  readonly parseError?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeText(value: unknown, maxBytes = 2_000): string {
  return capText(redact(stringValue(value)).trim(), maxBytes).text;
}

export function normalizeReviewPath(value: unknown, snapshotRoot = ""): string {
  const raw = stringValue(value).replaceAll("\\", "/");
  if (!raw) return "(unknown)";
  const relative = snapshotRoot && path.isAbsolute(raw) ? path.relative(snapshotRoot, raw) : raw;
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) return "(outside-snapshot)";
  return normalized;
}

export function normalizeSeverity(value: unknown, tool: "tflint" | "trivy"): ReviewSeverity {
  const severity = stringValue(value).toUpperCase();
  if (severity === "CRITICAL") return "CRITICAL";
  if (severity === "HIGH" || severity === "ERROR") return "HIGH";
  if (severity === "MEDIUM" || severity === "WARNING" || severity === "WARN") return "MEDIUM";
  if (severity === "LOW" || severity === "NOTICE") return "LOW";
  return tool === "tflint" ? "LOW" : "INFO";
}

export function qualifyTflintIssuePath(issue: unknown, directory: string): unknown {
  if (!isRecord(issue) || !isRecord(issue.range)) return issue;
  const filename = stringValue(issue.range.filename);
  if (!filename || path.isAbsolute(filename) || directory === ".") return issue;
  return {
    ...issue,
    range: {
      ...issue.range,
      filename: path.posix.join(directory.replaceAll("\\", "/"), filename.replaceAll("\\", "/")),
    },
  };
}

export function parseTflintJson(output: string, snapshotRoot = ""): ParsedScanner {
  try {
    const document: unknown = JSON.parse(output);
    if (!isRecord(document)) throw new Error("TFLint output is not an object.");
    const findings = arrayValue(document.issues).flatMap((issue): TerraformFinding[] => {
      if (!isRecord(issue)) return [];
      const rule = isRecord(issue.rule) ? issue.rule : {};
      const range = isRecord(issue.range) ? issue.range : {};
      const start = isRecord(range.start) ? range.start : {};
      const end = isRecord(range.end) ? range.end : {};
      const id = safeText(rule.name, 256) || "tflint-unknown";
      const message = safeText(issue.message) || "TFLint reported an issue.";
      const line = numberValue(start.line);
      const endLine = numberValue(end.line);
      const reference = safeText(rule.link, 1_000);
      return [{
        tool: "tflint",
        sources: ["tflint"],
        category: "correctness",
        id,
        severity: normalizeSeverity(rule.severity, "tflint"),
        file: normalizeReviewPath(range.filename, snapshotRoot),
        ...(line === undefined ? {} : { line }),
        ...(endLine === undefined ? {} : { endLine }),
        title: id.replaceAll("_", " "),
        message,
        ...(reference ? { reference } : {}),
        changedInPullRequest: false,
        addedInPullRequest: false,
      }];
    });
    const scannerErrors = arrayValue(document.errors)
      .map((error) => isRecord(error) ? safeText(error.message) : safeText(error))
      .filter(Boolean)
      .slice(0, 3);
    return {
      findings,
      ...(scannerErrors.length ? { parseError: `TFLint analysis errors: ${scannerErrors.join(" | ")}` } : {}),
    };
  } catch (error) {
    return { findings: [], parseError: redact(error instanceof Error ? error.message : String(error)) };
  }
}

export function parseTrivyJson(output: string, snapshotRoot = ""): ParsedScanner {
  try {
    const document: unknown = JSON.parse(output);
    if (!isRecord(document)) throw new Error("Trivy output is not an object.");
    const findings: TerraformFinding[] = [];
    for (const result of arrayValue(document.Results)) {
      if (!isRecord(result)) continue;
      const target = normalizeReviewPath(result.Target, snapshotRoot);
      for (const item of arrayValue(result.Misconfigurations)) {
        if (!isRecord(item) || stringValue(item.Status).toUpperCase() === "PASS") continue;
        const cause = isRecord(item.CauseMetadata) ? item.CauseMetadata : {};
        const id = safeText(item.ID, 256) || safeText(item.AVDID, 256) || "trivy-unknown";
        const message = safeText(item.Message) || safeText(item.Description) || "Trivy reported a misconfiguration.";
        const line = numberValue(cause.StartLine);
        const endLine = numberValue(cause.EndLine);
        const remediation = safeText(item.Resolution);
        const reference = safeText(item.PrimaryURL, 1_000);
        findings.push({
          tool: "trivy",
          sources: ["trivy"],
          category: categorizeFinding(id, safeText(item.Title) || id, "trivy"),
          id,
          severity: normalizeSeverity(item.Severity, "trivy"),
          file: target,
          ...(line === undefined ? {} : { line }),
          ...(endLine === undefined ? {} : { endLine }),
          title: safeText(item.Title) || id,
          message,
          ...(remediation ? { remediation } : {}),
          ...(reference ? { reference } : {}),
          changedInPullRequest: false,
          addedInPullRequest: false,
        });
      }
      for (const item of arrayValue(result.Secrets)) {
        if (!isRecord(item)) continue;
        const id = safeText(item.RuleID, 256) || safeText(item.Category, 256) || "trivy-secret";
        const line = numberValue(item.StartLine);
        const endLine = numberValue(item.EndLine);
        findings.push({
          tool: "trivy",
          sources: ["trivy"],
          category: "secrets",
          id,
          severity: normalizeSeverity(item.Severity, "trivy"),
          file: target,
          ...(line === undefined ? {} : { line }),
          ...(endLine === undefined ? {} : { endLine }),
          title: safeText(item.Title) || `Potential hardcoded secret (${id})`,
          message: `Trivy detected potential hardcoded secret material under rule ${id}. The matched value is intentionally omitted.`,
          remediation: "Remove the literal from code, rotate it if it was real, and reference a managed secret at runtime.",
          changedInPullRequest: false,
          addedInPullRequest: false,
        });
      }
    }
    return { findings };
  } catch (error) {
    return { findings: [], parseError: redact(error instanceof Error ? error.message : String(error)) };
  }
}

export function runFixedProcess(file: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return commandRunner.run({ file, args, cwd, timeoutMs: SCANNER_TIMEOUT_MS, maxBytes: MAX_PROCESS_BYTES });
}

async function runTflintDirectories(
  snapshotRoot: string,
  configPath: string,
  changedFiles: ReadonlySet<string>,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const directories = [...new Set([...changedFiles].map((file) => path.dirname(file)))].sort();
  const selected = directories.slice(0, 24);
  const results: ProcessResult[] = new Array(selected.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const directory = selected[index];
      if (directory === undefined) continue;
      results[index] = await runFixedProcess(reviewRuntime().binaries.tflint, [
        "--format=json",
        "--no-color",
        "--force",
        "--call-module-type=none",
        `--config=${configPath}`,
      ], path.join(snapshotRoot, directory));
    }
  });
  await Promise.all(workers);

  const issues: unknown[] = [];
  const errors: unknown[] = [];
  const stderr: string[] = [];
  let truncated = directories.length > selected.length;
  let timedOut = false;
  let exitCode = directories.length > selected.length ? 1 : 0;
  for (const [index, result] of results.entries()) {
    if (!result) continue;
    truncated ||= result.truncated;
    timedOut ||= result.timedOut;
    if (result.exitCode !== 0) exitCode = result.exitCode ?? 1;
    if (result.stderr) stderr.push(result.stderr);
    try {
      const document: unknown = JSON.parse(result.stdout);
      if (!isRecord(document)) throw new Error("TFLint module output is not an object.");
      issues.push(...arrayValue(document.issues).map((issue) => qualifyTflintIssuePath(issue, selected[index] ?? ".")));
      errors.push(...arrayValue(document.errors));
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error) });
      exitCode = 1;
    }
  }
  if (directories.length > selected.length) {
    errors.push({ message: `TFLint module-directory limit exceeded (${directories.length} > ${selected.length}).` });
  }
  return {
    stdout: JSON.stringify({ issues, errors }),
    stderr: stderr.join("\n"),
    exitCode,
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}

function isTerraformPath(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".tf") || lower.endsWith(".tf.json") || lower.endsWith(".tfvars") || lower.endsWith(".hcl");
}

function annotateAndFilter(
  findings: readonly TerraformFinding[],
  changedFiles: ReadonlySet<string>,
  addedLines: ReadonlyMap<string, ReadonlySet<number>>,
) {
  const annotated = findings.map((finding) => annotateFinding(finding, changedFiles, addedLines));
  return {
    rawCount: annotated.length,
    changed: annotated.filter((finding) => finding.changedInPullRequest),
  };
}

function scannerError(result: ProcessResult, parseError?: string): string | undefined {
  if (result.timedOut) return "Scanner timed out after 120 seconds.";
  if (result.exitCode !== 0) return parseError || safeText(result.stderr || `Scanner exited with code ${result.exitCode}.`, 2_000);
  if (result.truncated) return "Scanner output exceeded the four-megabyte safety limit.";
  return parseError;
}

export async function materializeChangedTerraformFiles(
  snapshotRoot: string,
  destination: string,
  changedFiles: ReadonlySet<string>,
): Promise<string[]> {
  const copied: string[] = [];
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of changedFiles) {
    const safePath = normalizeReviewPath(file);
    if (safePath === "(unknown)" || safePath === "(outside-snapshot)") continue;
    const source = path.join(snapshotRoot, safePath);
    const status = await lstat(source).catch(() => undefined);
    if (!status?.isFile()) continue;
    const target = path.join(destination, safePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    copied.push(safePath);
  }
  return copied;
}

export async function materializeSnapshot(snapshot: PullRequestSnapshot, destination: string): Promise<void> {
  const repository = resolveConfiguredRepository(snapshot.repository);
  const git = reviewRuntime().binaries.git;
  const cache = repositoryGitCachePath(repository);
  // Clone only from Friday's trusted writable bare cache. The host repository
  // remains mounted read-only and is never used as a fetch destination.
  await runCommand(git, ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", "--shared", cache, destination], {
    cwd: path.dirname(destination),
    timeoutMs: 60_000,
  });
  await runCommand(git, ["-c", "core.hooksPath=/dev/null", "-C", destination, "checkout", "--quiet", "--detach", snapshot.headSha], { cwd: destination });
}

function summarize(findings: readonly TerraformFinding[]) {
  const counts: Record<ReviewSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function summarizeCategories(findings: readonly TerraformFinding[]) {
  const counts: Partial<Record<ReviewCategory, number>> = {};
  for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  return counts;
}

async function runFridayPolicy(
  snapshotRoot: string,
  files: readonly string[],
  addedLines: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<{ findings: TerraformFinding[]; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  const findings: TerraformFinding[] = [];
  try {
    for (const file of files) {
      const source = await readFile(path.join(snapshotRoot, file), "utf8");
      findings.push(...scanFridayTerraformPolicy(file, source, addedLines.get(file) ?? new Set()));
    }
    return { findings, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      findings,
      durationMs: Date.now() - startedAt,
      error: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Runs the complete bounded Terraform review for one allowlisted PR. */
export async function reviewTerraformPullRequest(
  params: TerraformReviewParams,
  { snapshot: preparedSnapshot }: { readonly snapshot?: PullRequestSnapshot } = {},
) {
  // Phase 1: obtain the validated runtime and one redacted PR snapshot shared
  // with the other engines.
  const runtime = reviewRuntime();
  const tflint = runtime.binaries.tflint;
  const trivy = runtime.binaries.trivy;
  const trivyCache = path.join(runtime.storage.cacheDir, "trivy");
  // Unified Review already has a validated immutable snapshot. Reuse it so a
  // single Slack request does not repeat GitHub metadata reads, fetches, diffs
  // and redaction before starting the actual Terraform scanners.
  const snapshot = preparedSnapshot ?? await preparePullRequest(params.pullRequestUrl);
  const changedTerraformFiles = new Set(
    snapshot.changedFiles.map((file) => normalizeReviewPath(file.path)).filter(isTerraformPath),
  );
  // No applicable files is a successful no-op, not a scanner failure. Return
  // explicit skipped coverage so the unified router can explain the decision.
  if (changedTerraformFiles.size === 0) {
    const tools: ScannerStatus[] = [
      { tool: "friday-policy", status: "skipped", durationMs: 0, rawFindings: 0, changedFileFindings: 0, addedLineFindings: 0 },
      { tool: "tflint", status: "skipped", durationMs: 0, rawFindings: 0, changedFileFindings: 0, addedLineFindings: 0 },
      { tool: "trivy", status: "skipped", durationMs: 0, rawFindings: 0, changedFileFindings: 0, addedLineFindings: 0 },
    ];
    return {
      repository: snapshot.repository,
      pullRequest: snapshot.pullRequest,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      summary: { status: "pass", changedTerraformFiles: 0, findings: 0, addedLineFindings: 0, omittedBaselineFindings: 0, counts: summarize([]), categories: {} },
      findings: [],
      tools,
      gate: buildReviewGate([], tools),
      presentation: {
        format: "friday-structured-review-v1.1",
        requiredSections: ["Verdict", "Coverage", "Blocking findings", "Warnings", "Baseline and unknowns"],
        discloseSecretValues: false,
      },
      safety: {
        workingTreeChanged: false,
        pushedRemoteChanges: false,
        terraformInit: false,
        terraformPlan: false,
        terraformApply: false,
        scannerUpdates: false,
        secretsRedacted: true,
        temporarySnapshotRemoved: true,
      },
    };
  }

  // Phase 2: materialize only the immutable PR snapshot in a private temporary
  // tree. Scanner writes and caches never touch the repository working tree.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "friday-terraform-review-"));
  await chmod(tempRoot, 0o700);
  const snapshotRoot = path.join(tempRoot, "snapshot");
  try {
    await materializeSnapshot(snapshot, snapshotRoot);
    const trivyRoot = path.join(tempRoot, "trivy-snapshot");
    const trivyFiles = await materializeChangedTerraformFiles(snapshotRoot, trivyRoot, changedTerraformFiles);
    const addedLines = parseAddedLinesFromUnifiedDiff(snapshot.terraformDiff);
    const tflintConfig = path.join(tempRoot, "tflint.hcl");
    await writeFile(tflintConfig, 'plugin "terraform" {\n  enabled = true\n  preset  = "recommended"\n}\n', { mode: 0o600 });
    await mkdir(trivyCache, { recursive: true, mode: 0o700 });

    // Phase 3: detect optional binaries, then run deterministic policy, TFLint
    // and Trivy concurrently with fixed arguments and bounded output.
    const availability = await Promise.all([
      access(tflint).then(() => true).catch(() => false),
      access(trivy).then(() => true).catch(() => false),
    ]);
    const [tflintAvailable, trivyAvailable] = availability;
    const policyPromise = runFridayPolicy(snapshotRoot, trivyFiles, addedLines);
    const tflintPromise = tflintAvailable
      ? runTflintDirectories(snapshotRoot, tflintConfig, changedTerraformFiles)
      : Promise.resolve({ stdout: "", stderr: "TFLint is not installed.", exitCode: null, timedOut: false, truncated: false, durationMs: 0 });
    const trivyPromise = trivyAvailable
      ? trivyFiles.length === 0
        ? Promise.resolve({ stdout: "", stderr: "No regular changed Terraform files could be materialized.", exitCode: null, timedOut: false, truncated: false, durationMs: 0 })
        : runFixedProcess(reviewRuntime().binaries.trivy, [
          "filesystem",
          "--format=json",
          "--quiet",
          "--scanners=misconfig,secret",
          "--skip-check-update",
          "--skip-version-check",
          "--timeout=2m",
          "--misconfig-scanners=terraform",
          "--skip-dirs=.terraform",
          `--cache-dir=${path.join(reviewRuntime().storage.cacheDir, "trivy")}`,
          trivyRoot,
        ], trivyRoot)
      : Promise.resolve({ stdout: "", stderr: "Trivy is not installed.", exitCode: null, timedOut: false, truncated: false, durationMs: 0 });

    const [policyResult, tflintResult, trivyResult] = await Promise.all([policyPromise, tflintPromise, trivyPromise]);

    // Phase 4: parse scanner-specific payloads into one finding model, attribute
    // findings to changed/added lines and deduplicate overlapping evidence.
    const parsedTflint = tflintResult.stdout ? parseTflintJson(tflintResult.stdout, snapshotRoot) : { findings: [] };
    const parsedTrivy = trivyResult.exitCode === 0 ? parseTrivyJson(trivyResult.stdout, trivyRoot) : { findings: [] };
    const policyFindings = annotateAndFilter(policyResult.findings, changedTerraformFiles, addedLines);
    const tflintFindings = annotateAndFilter(parsedTflint.findings, changedTerraformFiles, addedLines);
    const trivyFindings = annotateAndFilter(parsedTrivy.findings, changedTerraformFiles, addedLines);
    const tflintError = scannerError(tflintResult, parsedTflint.parseError);
    const trivyError = scannerError(trivyResult, parsedTrivy.parseError);
    const allDeduplicatedFindings = deduplicateFindings([
      ...policyFindings.changed,
      ...tflintFindings.changed,
      ...trivyFindings.changed,
    ]);
    const findings = allDeduplicatedFindings.slice(0, MAX_FINDINGS);
    const omittedBaselineFindings = (policyFindings.rawCount - policyFindings.changed.length)
      + (tflintFindings.rawCount - tflintFindings.changed.length)
      + (trivyFindings.rawCount - trivyFindings.changed.length);
    // Phase 5: retain coverage status independently from findings. A missing or
    // failed required scanner makes the final gate NEEDS_HUMAN.
    const tools: ScannerStatus[] = [
      {
        tool: "friday-policy",
        status: policyResult.error ? "error" : "success",
        durationMs: policyResult.durationMs,
        rawFindings: policyFindings.rawCount,
        changedFileFindings: policyFindings.changed.length,
        addedLineFindings: policyFindings.changed.filter((finding) => finding.addedInPullRequest).length,
        ...(policyResult.error ? { error: policyResult.error } : {}),
      },
      {
        tool: "tflint",
        status: !tflintAvailable ? "unavailable" : tflintError ? "error" : "success",
        durationMs: tflintResult.durationMs,
        rawFindings: tflintFindings.rawCount,
        changedFileFindings: tflintFindings.changed.length,
        addedLineFindings: tflintFindings.changed.filter((finding) => finding.addedInPullRequest).length,
        ...(tflintError ? { error: tflintError } : {}),
      },
      {
        tool: "trivy",
        status: !trivyAvailable || trivyFiles.length === 0 ? "unavailable" : trivyError ? "error" : "success",
        durationMs: trivyResult.durationMs,
        rawFindings: trivyFindings.rawCount,
        changedFileFindings: trivyFindings.changed.length,
        addedLineFindings: trivyFindings.changed.filter((finding) => finding.addedInPullRequest).length,
        ...(trivyError ? { error: trivyError } : {}),
      },
    ];
    // Phase 6: build the conservative merge gate and bounded response contract.
    const gate = buildReviewGate(findings, tools);
    return {
      repository: snapshot.repository,
      pullRequest: snapshot.pullRequest,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      summary: {
        status: gate.verdict === "NEEDS_HUMAN" ? "partial" : findings.length ? "findings" : "pass",
        changedTerraformFiles: changedTerraformFiles.size,
        findings: findings.length,
        addedLineFindings: findings.filter((finding) => finding.addedInPullRequest).length,
        omittedBaselineFindings,
        truncated: allDeduplicatedFindings.length > MAX_FINDINGS,
        counts: summarize(findings),
        categories: summarizeCategories(findings),
      },
      findings,
      tools,
      gate,
      presentation: {
        format: "friday-structured-review-v1.1",
        requiredSections: ["Verdict", "Coverage", "Blocking findings", "Warnings", "Baseline and unknowns"],
        discloseSecretValues: false,
      },
      safety: {
        workingTreeChanged: false,
        pushedRemoteChanges: false,
        terraformInit: false,
        terraformPlan: false,
        terraformApply: false,
        scannerUpdates: false,
        secretsRedacted: true,
        temporarySnapshotRemoved: true,
      },
    };
  } finally {
    // Cleanup is unconditional, including parse/scanner failures.
    await rm(tempRoot, { recursive: true, force: true });
  }
}
