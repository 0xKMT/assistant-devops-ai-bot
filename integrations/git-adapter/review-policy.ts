/**
 * Deterministic Terraform policy, changed-line attribution and merge-gate
 * construction. Findings are normalized here before any human-facing summary.
 */
import type {
  ReviewCategory,
  ReviewGate,
  ReviewSeverity,
  ScannerStatus,
  TerraformFinding,
} from "./terraform-review.js";

const SENSITIVE_NAME = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SEVERITY_ORDER: Readonly<Record<ReviewSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};
const TOOL_ORDER = ["friday-policy", "trivy", "tflint"] as const;

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isDynamicValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.includes("${")
    || normalized.includes("{{")
    || /^(?:var|local|module|data)\./i.test(normalized)
    || /^aws_(?:ssm|secretsmanager)/i.test(normalized);
}

function stripCommentsPreservingLines(source: string): string {
  // Replace comments with whitespace instead of deleting them. Scanner offsets
  // then still point to the original source line shown to the reviewer.
  let output = "";
  let index = 0;
  let quote = "";
  let blockComment = false;
  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (blockComment) {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 2;
        blockComment = false;
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += current;
      if (current === "\\" && next) {
        output += next;
        index += 2;
        continue;
      }
      if (current === quote) quote = "";
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      blockComment = true;
      continue;
    }
    if (current === "#" || (current === "/" && next === "/")) {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

function policyFinding(
  id: string,
  file: string,
  line: number,
  title: string,
  message: string,
  remediation: string,
  addedLines: ReadonlySet<number>,
): TerraformFinding {
  return {
    tool: "friday-policy",
    sources: ["friday-policy"],
    category: "secrets",
    id,
    severity: "CRITICAL",
    file,
    line,
    endLine: line,
    title,
    message,
    remediation,
    changedInPullRequest: true,
    addedInPullRequest: addedLines.has(line),
  };
}

export function scanFridayTerraformPolicy(
  file: string,
  source: string,
  addedLines: ReadonlySet<number> = new Set(),
): TerraformFinding[] {
  const sanitized = stripCommentsPreservingLines(source);
  const findings: TerraformFinding[] = [];
  const claimedLines = new Set<number>();

  // Phase 1: catch common ECS/container-style name/value objects. Claimed
  // lines prevent the generic assignment scan below from reporting duplicates.
  const objectPattern = /\{[^{}]{0,4000}\}/gs;
  for (const objectMatch of sanitized.matchAll(objectPattern)) {
    const block = objectMatch[0];
    const blockOffset = objectMatch.index ?? 0;
    const name = /["']?name["']?\s*[=:]\s*(["'])([^"'\n]+)\1/i.exec(block);
    if (!name || !SENSITIVE_NAME.test(name[2] ?? "")) continue;
    const value = /["']?value["']?\s*[=:]\s*(["'])([^"'\n]*)\1/i.exec(block);
    if (!value || isDynamicValue(value[2] ?? "")) continue;
    const valueOffset = blockOffset + (value.index ?? 0);
    const line = lineNumberAt(sanitized, valueOffset);
    claimedLines.add(line);
    findings.push(policyFinding(
      "FRIDAY-TF-SECRET-001",
      file,
      line,
      "Sensitive environment variable uses a literal value",
      "A password, token, key, or secret-like environment variable is assigned a hardcoded literal. The literal value is intentionally omitted.",
      "Reference the secret through AWS Secrets Manager or SSM Parameter Store using valueFrom instead of a plaintext environment value.",
      addedLines,
    ));
  }

  // Phase 2: catch direct Terraform/HCL assignments not represented by an
  // object. Dynamic secret references are safe evidence and are excluded.
  const directPattern = /^\s*["']?([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[=:]\s*(["'])([^"'\n]*)\2/gim;
  for (const match of sanitized.matchAll(directPattern)) {
    const literal = match[3] ?? "";
    if (isDynamicValue(literal)) continue;
    const line = lineNumberAt(sanitized, match.index ?? 0);
    if (claimedLines.has(line)) continue;
    findings.push(policyFinding(
      "FRIDAY-TF-SECRET-002",
      file,
      line,
      "Sensitive Terraform field uses a literal value",
      "A password, token, key, or secret-like Terraform field is assigned a hardcoded literal. The literal value is intentionally omitted.",
      "Replace the literal with a sensitive variable or a Secrets Manager/SSM reference and prevent the value from being emitted to code, logs, plans, or Slack.",
      addedLines,
    ));
  }
  return findings;
}

function unquoteDiffPath(value: string): string {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith("b/") ? trimmed.slice(2) : trimmed;
  return withoutPrefix.replace(/^"|"$/g, "");
}

export function parseAddedLinesFromUnifiedDiff(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let file = "";
  let newLine = 0;
  let inHunk = false;
  // Walk unified-diff coordinates rather than source text so only added PR
  // lines can affect the new-change merge gate.
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const candidate = unquoteDiffPath(line.slice(4));
      file = candidate === "/dev/null" ? "" : candidate;
      if (file && !result.has(file)) result.set(file, new Set());
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.get(file)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted lines do not advance the new-file line number.
    } else if (!line.startsWith("\\")) {
      newLine += 1;
    }
  }
  return result;
}

export function categorizeFinding(id: string, title: string, tool: TerraformFinding["tool"]): ReviewCategory {
  const text = `${id} ${title}`.toLowerCase();
  if (/secret|password|passwd|credential|token|private.?key|access.?key/.test(text)) return "secrets";
  if (/iam|principal|policy|privilege|permission/.test(text)) return "identity";
  if (/encrypt|kms|cmk|unencrypted/.test(text)) return "encryption";
  if (/network|public|ingress|egress|security.?group|cidr/.test(text)) return "network";
  if (/log|monitor|alarm|backup|retention|availability/.test(text)) return "reliability";
  if (/cost|expensive|instance.?type|capacity/.test(text)) return "cost";
  if (tool === "tflint") return "correctness";
  return "other";
}

export function annotateFinding(
  finding: TerraformFinding,
  changedFiles: ReadonlySet<string>,
  addedLines: ReadonlyMap<string, ReadonlySet<number>>,
): TerraformFinding {
  const file = finding.file.replace(/^\.\//, "");
  const line = finding.line;
  return {
    ...finding,
    file,
    category: finding.category || categorizeFinding(finding.id, finding.title, finding.tool),
    sources: finding.sources.length ? finding.sources : [finding.tool],
    changedInPullRequest: changedFiles.has(file),
    addedInPullRequest: line !== undefined && (addedLines.get(file)?.has(line) ?? false),
  };
}

function shouldMerge(left: TerraformFinding, right: TerraformFinding): boolean {
  if (left.file !== right.file) return false;
  if (left.id === right.id && left.line === right.line) return true;
  if (left.category !== right.category || left.tool === right.tool) return false;
  if (left.line === undefined || right.line === undefined) return false;
  return Math.abs(left.line - right.line) <= (left.category === "secrets" ? 3 : 1);
}

function preferredFinding(left: TerraformFinding, right: TerraformFinding): TerraformFinding {
  const severity = SEVERITY_ORDER[left.severity] <= SEVERITY_ORDER[right.severity] ? left : right;
  const toolRank = (finding: TerraformFinding) => TOOL_ORDER.indexOf(finding.tool);
  const preferred = toolRank(left) <= toolRank(right) ? left : right;
  return {
    ...preferred,
    severity: severity.severity,
    sources: [...new Set([...left.sources, ...right.sources])],
    addedInPullRequest: left.addedInPullRequest || right.addedInPullRequest,
    changedInPullRequest: left.changedInPullRequest || right.changedInPullRequest,
  };
}

export function deduplicateFindings(findings: readonly TerraformFinding[]): TerraformFinding[] {
  // Keep one stable representative while preserving the strongest severity and
  // all scanner sources; Slack receives an actionable issue, not scanner noise.
  const output: TerraformFinding[] = [];
  for (const finding of findings) {
    const index = output.findIndex((candidate) => shouldMerge(candidate, finding));
    if (index < 0) output.push(finding);
    else output[index] = preferredFinding(output[index]!, finding);
  }
  return output.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || Number(right.addedInPullRequest) - Number(left.addedInPullRequest)
    || left.file.localeCompare(right.file)
    || (left.line ?? 0) - (right.line ?? 0));
}

/** Fails closed when required coverage is incomplete or new blockers exist. */
export function buildReviewGate(findings: readonly TerraformFinding[], tools: readonly ScannerStatus[]): ReviewGate {
  const incomplete = tools.filter((tool) => !["success", "skipped"].includes(tool.status));
  const blocking = findings.filter((finding) =>
    finding.addedInPullRequest && (finding.severity === "CRITICAL" || finding.severity === "HIGH"));
  const reasons: string[] = [];
  if (blocking.length) reasons.push(`${blocking.length} Critical/High finding(s) occur on added PR lines.`);
  if (incomplete.length) reasons.push(`Required coverage incomplete: ${incomplete.map((tool) => tool.tool).join(", ")}.`);
  if (!blocking.length && !incomplete.length && findings.length) reasons.push(`${findings.length} non-blocking changed-file finding(s) require review.`);
  if (!findings.length && !incomplete.length) reasons.push("All required scanners completed with no changed-file findings.");
  const verdict: ReviewGate["verdict"] = blocking.length
    ? "BLOCK"
    : incomplete.length
      ? "NEEDS_HUMAN"
      : findings.length
        ? "WARN"
        : "PASS";
  return {
    verdict,
    reviewComplete: incomplete.length === 0,
    mergeRecommended: verdict === "PASS",
    blockingFindingIds: blocking.map((finding) => `${finding.id}:${finding.file}:${finding.line ?? 0}`),
    reasons,
  };
}
