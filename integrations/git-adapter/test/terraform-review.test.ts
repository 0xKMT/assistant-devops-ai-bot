import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReviewPath,
  normalizeSeverity,
  parseTflintJson,
  parseTrivyJson,
  qualifyTflintIssuePath,
} from "../terraform-review.js";

test("normalizes scanner severities and blocks paths outside the snapshot", () => {
  assert.equal(normalizeSeverity("error", "tflint"), "HIGH");
  assert.equal(normalizeSeverity("WARNING", "tflint"), "MEDIUM");
  assert.equal(normalizeSeverity("CRITICAL", "trivy"), "CRITICAL");
  assert.equal(normalizeReviewPath("./modules/app/main.tf"), "modules/app/main.tf");
  assert.equal(normalizeReviewPath("/private/secret.tf", "/private/tmp/review"), "(outside-snapshot)");
});

test("qualifies TFLint module-relative paths before PR filtering", () => {
  const issue = qualifyTflintIssuePath({ range: { filename: "main.tf", start: { line: 2 } } }, "modules/app");
  assert.deepEqual(issue, { range: { filename: "modules/app/main.tf", start: { line: 2 } } });
});

test("parses TFLint JSON without exposing arbitrary fields", () => {
  const parsed = parseTflintJson(JSON.stringify({
    issues: [{
      rule: { name: "terraform_unused_declarations", severity: "warning", link: "https://example.test/rule" },
      message: "variable is declared but not used",
      range: { filename: "/private/tmp/review/modules/app/main.tf", start: { line: 8 }, end: { line: 8 } },
      ignored: "secret content",
    }],
  }), "/private/tmp/review");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.file, "modules/app/main.tf");
  assert.equal(parsed.findings[0]?.severity, "MEDIUM");
  assert.doesNotMatch(JSON.stringify(parsed), /secret content/);
});

test("parses Trivy misconfiguration JSON and omits code excerpts", () => {
  const parsed = parseTrivyJson(JSON.stringify({
    Results: [{
      Target: "/private/tmp/review/modules/app/main.tf",
      Misconfigurations: [{
        ID: "AVD-AWS-0086",
        Title: "Public access is not blocked",
        Message: "Bucket does not block public access",
        Resolution: "Enable all public access block settings",
        Severity: "HIGH",
        Status: "FAIL",
        PrimaryURL: "https://example.test/check",
        CauseMetadata: { StartLine: 10, EndLine: 16, Code: { Lines: [{ Content: "password = secret" }] } },
      }],
    }],
  }), "/private/tmp/review");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.id, "AVD-AWS-0086");
  assert.equal(parsed.findings[0]?.line, 10);
  assert.doesNotMatch(JSON.stringify(parsed), /password = secret/);
});

test("parses Trivy secret findings without returning matched secret material", () => {
  const parsed = parseTrivyJson(JSON.stringify({
    Results: [{
      Target: "/private/tmp/review/modules/app/main.tf",
      Secrets: [{
        RuleID: "synthetic-secret-rule",
        Category: "Generic",
        Severity: "HIGH",
        Title: "Potential secret",
        StartLine: 17,
        EndLine: 17,
        Match: "credential-value-that-must-not-leak",
        Code: { Lines: [{ Content: "token = credential-value-that-must-not-leak" }] },
      }],
    }],
  }), "/private/tmp/review");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.category, "secrets");
  assert.equal(parsed.findings[0]?.line, 17);
  assert.doesNotMatch(JSON.stringify(parsed), /credential-value-that-must-not-leak/);
});

test("returns parse errors instead of throwing on malformed scanner output", () => {
  assert.match(parseTflintJson("not-json").parseError ?? "", /JSON/);
  assert.match(parseTrivyJson("not-json").parseError ?? "", /JSON/);
});

test("keeps TFLint findings while surfacing module analysis errors", () => {
  const parsed = parseTflintJson(JSON.stringify({
    issues: [{
      rule: { name: "terraform_deprecated_interpolation", severity: "warning" },
      message: "Interpolation-only expression is deprecated",
      range: { filename: "main.tf", start: { line: 3 }, end: { line: 3 } },
    }],
    errors: [{ message: "A local module could not be evaluated without init" }],
  }));
  assert.equal(parsed.findings.length, 1);
  assert.match(parsed.parseError ?? "", /could not be evaluated/);
});
