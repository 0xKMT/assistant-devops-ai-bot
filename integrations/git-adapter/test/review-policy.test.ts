import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildReviewGate,
  deduplicateFindings,
  parseAddedLinesFromUnifiedDiff,
  scanFridayTerraformPolicy,
} from "../review-policy.js";
import type { ScannerStatus, TerraformFinding } from "../terraform-review.js";

interface PolicyCase {
  readonly id: string;
  readonly expect: boolean;
  readonly source: string;
}

const cases = JSON.parse(readFileSync(
  new URL("./fixtures/review-engine-v1.1/cases.json", import.meta.url),
  "utf8",
)) as PolicyCase[];

test("Review Engine v1.1 corpus contains exactly 20 synthetic cases", () => {
  assert.equal(cases.length, 20);
});

for (const fixture of cases) {
  test(`Friday policy corpus: ${fixture.id}`, () => {
    const added = new Set(fixture.source.split("\n").map((_line, index) => index + 1));
    const findings = scanFridayTerraformPolicy("modules/service/main.tf", fixture.source, added);
    assert.equal(findings.length > 0, fixture.expect);
    if (fixture.expect) {
      assert.ok(findings.every((finding) => finding.category === "secrets"));
      assert.ok(findings.every((finding) => finding.addedInPullRequest));
      assert.doesNotMatch(JSON.stringify(findings), /synthetic-(?:password|token|key|secret)/);
    }
  });
}

test("attributes only added lines from a unified PR diff", () => {
  const added = parseAddedLinesFromUnifiedDiff([
    "diff --git a/modules/app/main.tf b/modules/app/main.tf",
    "--- a/modules/app/main.tf",
    "+++ b/modules/app/main.tf",
    "@@ -8,2 +8,3 @@",
    " context",
    "+password = \"synthetic-password\"",
    " context",
  ].join("\n"));
  assert.deepEqual([...added.get("modules/app/main.tf") ?? []], [9]);
});

function finding(overrides: Partial<TerraformFinding> = {}): TerraformFinding {
  return {
    tool: "friday-policy",
    sources: ["friday-policy"],
    category: "secrets",
    id: "FRIDAY-TF-SECRET-001",
    severity: "CRITICAL",
    file: "modules/app/main.tf",
    line: 9,
    title: "Hardcoded secret",
    message: "Secret value intentionally omitted.",
    changedInPullRequest: true,
    addedInPullRequest: true,
    ...overrides,
  };
}

function scanner(tool: ScannerStatus["tool"], status: ScannerStatus["status"]): ScannerStatus {
  return { tool, status, durationMs: 1, rawFindings: 0, changedFileFindings: 0, addedLineFindings: 0 };
}

test("deduplicates overlapping secret findings and preserves sources", () => {
  const findings = deduplicateFindings([
    finding(),
    finding({ tool: "trivy", sources: ["trivy"], id: "generic-secret", line: 10, severity: "HIGH" }),
  ]);
  assert.equal(findings.length, 1);
  assert.deepEqual(new Set(findings[0]?.sources), new Set(["friday-policy", "trivy"]));
  assert.equal(findings[0]?.severity, "CRITICAL");
});

test("blocks new Critical/High findings and fails closed on incomplete coverage", () => {
  const complete = [scanner("friday-policy", "success"), scanner("tflint", "success"), scanner("trivy", "success")];
  assert.equal(buildReviewGate([finding()], complete).verdict, "BLOCK");
  assert.equal(buildReviewGate([], [...complete.slice(0, 2), scanner("trivy", "error")]).verdict, "NEEDS_HUMAN");
  assert.equal(buildReviewGate([], complete).verdict, "PASS");
});
