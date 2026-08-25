import test from "node:test";
import assert from "node:assert/strict";
import { selectReviewSnippets } from "../review-snippets.js";

const diff = [
  "diff --git a/infra/main.tf b/infra/main.tf",
  "--- a/infra/main.tf",
  "+++ b/infra/main.tf",
  "@@ -10,3 +10,4 @@ resource \"aws_s3_bucket\" \"logs\" {",
  "   bucket = \"logs\"",
  "+  force_destroy = true",
  "   tags = {",
  "     Environment = \"prd\"",
  "diff --git a/values/prd.yaml b/values/prd.yaml",
  "--- a/values/prd.yaml",
  "+++ b/values/prd.yaml",
  "@@ -6,2 +6,4 @@ replicas: 2",
  " replicas: 2",
  "+resources:",
  "+  limits:",
  "+    cpu: 500m",
].join("\n");

const secretDiff = [
  "diff --git a/infra/main.tf b/infra/main.tf",
  "--- a/infra/main.tf",
  "+++ b/infra/main.tf",
  "@@ -5,2 +5,4 @@ resource \"example\" \"service\" {",
  "   name = \"service\"",
  "+  api_token = \"actual-secret-value\"",
  "+  enabled = true",
].join("\n");

test("selects at most two redacted eight-line snippets from matching changed hunks", () => {
  const snippets = selectReviewSnippets(diff, [
    { key: "a", file: "infra/main.tf", line: 12 },
    { key: "b", file: "values/prd.yaml", line: 8 },
    { key: "c", file: "ignored.tf", line: 2 },
  ]);
  assert.equal(snippets.length, 2);
  assert.ok(snippets.every((snippet) => snippet.code.split("\n").length <= 8));
  assert.deepEqual(snippets.map((snippet) => snippet.language), ["hcl", "yaml"]);
});

test("enforces the two-snippet and eight-line boundaries with three valid long hunks", () => {
  const longDiff = [
    "+++ b/first.tf",
    "@@ -100,10 +100,10 @@",
    ...Array.from({ length: 10 }, (_, index) => `+first_${index} = true`),
    "diff --git a/second.yaml b/second.yaml",
    "+++ b/second.yaml",
    "@@ -200,10 +200,10 @@",
    ...Array.from({ length: 10 }, (_, index) => `+second_${index}: true`),
    "diff --git a/third.json b/third.json",
    "+++ b/third.json",
    "@@ -300,10 +300,10 @@",
    ...Array.from({ length: 10 }, (_, index) => `+\"third_${index}\": true`),
  ].join("\n");

  const snippets = selectReviewSnippets(longDiff, [
    { key: "first", file: "first.tf", line: 106 },
    { key: "second", file: "second.yaml", line: 209 },
    { key: "third", file: "third.json", line: 304 },
  ]);

  assert.deepEqual(snippets.map((snippet) => snippet.key), ["first", "second"]);
  assert.deepEqual(snippets.map(({ startLine, endLine }) => [startLine, endLine]), [[102, 109], [202, 209]]);
  assert.deepEqual(snippets.map((snippet) => snippet.code.split("\n").length), [8, 8]);
  assert.ok(snippets.every((snippet, index) => {
    const candidateLine = [106, 209][index] ?? 0;
    return snippet.startLine <= candidateLine && candidateLine <= snippet.endLine;
  }));
});

test("refuses secret-like literals and candidates without changed-hunk evidence", () => {
  const snippets = selectReviewSnippets(secretDiff, [
    { key: "secret", file: "infra/main.tf", line: 7 },
    { key: "missing", file: "infra/main.tf", line: 99 },
  ]);
  assert.deepEqual(snippets, []);
  assert.doesNotMatch(JSON.stringify(snippets), /actual-secret-value/);
});

test("refuses excerpts with multiline, quoted, adjacent, or incomplete secret material", () => {
  const fixtures = [
    {
      file: "apps/deployment.yaml",
      line: 2,
      plaintext: "synthetic-password",
      diff: [
        "+++ b/apps/deployment.yaml",
        "@@ -1,2 +1,2 @@",
        "+- name: POSTGRES_PASSWORD",
        "+  value: synthetic-password",
      ].join("\n"),
    },
    {
      file: "config/app.json",
      line: 1,
      plaintext: "quoted-secret",
      diff: [
        "+++ b/config/app.json",
        "@@ -1,1 +1,1 @@",
        "+{\"api_token\": \"quoted-secret\"}",
      ].join("\n"),
    },
    {
      file: "config/key.yaml",
      line: 2,
      plaintext: "synthetic-key-body",
      diff: [
        "+++ b/config/key.yaml",
        "@@ -1,2 +1,2 @@",
        "+private_key: |",
        `+  -----BEGIN ${["PRIVATE", "KEY"].join(" ")}----- synthetic-key-body`,
      ].join("\n"),
    },
  ];

  for (const fixture of fixtures) {
    const serialized = JSON.stringify(selectReviewSnippets(fixture.diff, [
      { key: fixture.file, file: fixture.file, line: fixture.line },
    ]));
    assert.equal(serialized, "[]");
    assert.doesNotMatch(serialized, new RegExp(fixture.plaintext));
  }
});

test("returns an exact Slack-safe rendering transport for hostile code and filenames", () => {
  const hostileFile = "infra/`<@U123|alerts>`.TF";
  const hostileDiff = [
    `+++ b/${hostileFile}`,
    "@@ -7,4 +7,4 @@",
    "+message = \"```\"",
    "+mention = \"<!channel> <@U123>\"",
    "+link = \"<https://evil.example|click>\"",
    "+control = \"before\u0007after\"",
  ].join("\n");

  const snippet = selectReviewSnippets(hostileDiff, [{ key: hostileFile, file: hostileFile, line: 8 }])[0];
  assert.ok(snippet);
  assert.equal(snippet.key, "infra/%60%3C%40U123%7Calerts%3E%60.TF");
  assert.equal(snippet.file, "infra/%60%3C%40U123%7Calerts%3E%60.TF");
  assert.equal(snippet.language, "hcl");
  assert.equal(snippet.rendered, [
    "`infra/%60%3C%40U123%7Calerts%3E%60.TF:8`",
    "```hcl",
    "message = \"\\u0060\\u0060\\u0060\"",
    "mention = \"\\u003c\\u0021channel\\u003e \\u003c\\u0040U123\\u003e\"",
    "link = \"\\u003chttps://evil.example|click\\u003e\"",
    "control = \"before\\u0007after\"",
    "```",
  ].join("\n"));
  assert.doesNotMatch(snippet.rendered, /<!channel>|<@U123>|<https?:|\u0007/);
});

test("keeps added source lines that begin with two plus characters and exact surrounding whitespace", () => {
  const plusDiff = [
    "+++ b/infra/main.tf",
    "@@ -1,1 +1,3 @@",
    "+  before = true",
    "+++counter = 1",
    "+  after = true",
  ].join("\n");
  const whitespaceDiff = [
    "+++ b/infra/main.tf",
    "@@ -1,1 +1,2 @@",
    "+    indented = true",
    " ",
  ].join("\n");

  assert.match(selectReviewSnippets(plusDiff, [{ key: "plus", file: "infra/main.tf", line: 3 }])[0]?.code ?? "", /\+\+counter = 1/);
  assert.equal(
    selectReviewSnippets(whitespaceDiff, [{ key: "spaces", file: "infra/main.tf", line: 1 }])[0]?.code,
    "    indented = true\n",
  );
});

test("accepts safe generic diff headers, maps extension variants, and rejects malformed headers", () => {
  const genericDiff = [
    "+++ infra/variables.tfvars",
    "@@ -2,1 +2,1 @@",
    "+region = \"ap-southeast-1\"",
  ].join("\n");
  const yamlDiff = [
    "+++ values/prd.yml",
    "@@ -4,1 +4,1 @@",
    "+enabled: true",
  ].join("\n");
  const malformedDiff = [
    "+++ /etc/passwd",
    "@@ -1,1 +1,1 @@",
    "+not_a_safe_path = true",
  ].join("\n");
  const uppercaseDiff = [
    "+++ values/PROD.YAML",
    "@@ -9,1 +9,1 @@",
    "+enabled: true",
    "diff --git a/config/POLICY.JSON b/config/POLICY.JSON",
    "+++ config/POLICY.JSON",
    "@@ -3,1 +3,1 @@",
    "+{\"enabled\": true}",
  ].join("\n");

  assert.equal(selectReviewSnippets(genericDiff, [{ key: "tfvars", file: "infra/variables.tfvars", line: 2 }])[0]?.language, "hcl");
  assert.equal(selectReviewSnippets(yamlDiff, [{ key: "yml", file: "values/prd.yml", line: 4 }])[0]?.language, "yaml");
  assert.deepEqual(selectReviewSnippets(uppercaseDiff, [
    { key: "yaml", file: "values/PROD.YAML", line: 9 },
    { key: "json", file: "config/POLICY.JSON", line: 3 },
  ]).map((snippet) => snippet.language), ["yaml", "json"]);
  assert.deepEqual(selectReviewSnippets(malformedDiff, [{ key: "unsafe", file: "/etc/passwd", line: 1 }]), []);
});

test("uses exactly the detected language in rendered transport and otherwise omits the label", () => {
  const languageDiff = [
    "+++ config/app.JSON",
    "@@ -1,1 +1,1 @@",
    "+{\"enabled\": true}",
    "diff --git a/config/app.txt b/config/app.txt",
    "+++ config/app.txt",
    "@@ -1,1 +1,1 @@",
    "+enabled=true",
  ].join("\n");
  const snippets = selectReviewSnippets(languageDiff, [
    { key: "known", file: "config/app.JSON", line: 1 },
    { key: "unknown", file: "config/app.txt", line: 1 },
  ]);

  assert.equal(snippets[0]?.language, "json");
  assert.match(snippets[0]?.rendered ?? "", /^`config\/app\.JSON:1`\n```json\n/);
  assert.equal(snippets[1]?.language, undefined);
  assert.match(snippets[1]?.rendered ?? "", /^`config\/app\.txt:1`\n```\nenabled=true\n```$/);
});

test("skips excerpts that become redacted-only", () => {
  const token = ["gh", "p_123456789012345678901234567890"].join("");
  const redactedOnlyDiff = [
    "+++ infra/main.tf",
    "@@ -1,1 +1,1 @@",
    `+${token}`,
  ].join("\n");

  assert.deepEqual(selectReviewSnippets(redactedOnlyDiff, [{ key: "token", file: "infra/main.tf", line: 1 }]), []);
});
