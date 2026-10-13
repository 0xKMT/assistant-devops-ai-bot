import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeFridayOutput } from "../core.js";

// Synthetic values are assembled at runtime so the portability secret audit
// never sees a credential-shaped literal in source.
const join = (...parts: string[]): string => parts.join("");
const body = (length: number, seed = "aB3"): string => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

/** One sample per shared family, with the substring that must never survive. */
const FAMILIES: ReadonlyArray<{ readonly family: string; readonly value: string; readonly secret: string }> = [
  { family: "private key", value: join("-----", "BEGIN RSA ", "PRIVATE KEY-----\n", body(64), "\n-----", "END RSA ", "PRIVATE KEY-----"), secret: body(64) },
  { family: "truncated private key", value: join("-----", "BEGIN OPENSSH ", "PRIVATE KEY-----\n", body(64, "Tk9")), secret: body(64, "Tk9") },
  { family: "AKIA", value: join("AK", "IA", body(16, "Q7")), secret: body(16, "Q7") },
  { family: "ASIA", value: join("AS", "IA", body(16, "Z9")), secret: body(16, "Z9") },
  ...["p", "o", "u", "s", "r"].map((kind) => ({ family: `gh${kind}_`, value: join("gh", kind, "_", body(36)), secret: body(36) })),
  { family: "github_pat_", value: join("github", "_pat_", body(60)), secret: body(60) },
  { family: "xoxb-", value: join("xo", "xb-", body(30, "1a-")), secret: body(30, "1a-") },
  { family: "xoxp-", value: join("xo", "xp-", body(30, "1a-")), secret: body(30, "1a-") },
  { family: "xapp-", value: join("xa", "pp-", body(30, "1a-")), secret: body(30, "1a-") },
  { family: "Slack webhook", value: join("https://hooks.", "slack.com/services/", "T0000/B0000/", body(24)), secret: body(24) },
  { family: "sk-", value: join("s", "k-", body(40)), secret: body(40) },
  { family: "sk-proj-", value: join("s", "k-proj-", body(40)), secret: body(40) },
  { family: "JWT", value: join("ey", "J", body(20), ".", "ey", "J", body(40), ".", body(43, "x_9")), secret: body(43, "x_9") },
  { family: "URL userinfo", value: join("https://deploy", ":", body(16, "pW7"), "@", "example.invalid/repo.git"), secret: body(16, "pW7") },
];

/** Contexts a family can appear in; the narrowing guard runs every pair. */
const CONTEXTS: readonly ((value: string) => string)[] = [
  (value) => `plain ${value} text`,
  (value) => `+  token = "${value}"`,
  (value) => `  apiKey: ${value}`,
  (value) => `{ name = "db_password", value = "${value}" }`,
  (value) => `Authorization: Bearer ${value}`,
  (value) => `https://example.invalid/?token=${value}&x=1`,
];

/** Token-ish text that is not a credential and must stay byte-identical. */
const FALSE_POSITIVE_CORPUS: readonly string[] = [
  "commit 4f1c2b8d9e0a7f6b5c4d3e2f1a0b9c8d7e6f5a4b",
  "image: registry.invalid/app@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "request 123e4567-e89b-12d3-a456-426614174000 accepted",
  "resource \"aws_instance\" \"web\" { id = \"i-0abcd1234efgh5678\" }",
  "arn:aws:iam::123456789012:role/friday-readonly-review",
  "helm value release-sk-frontend-canary-rollout-blue-green-strategy",
  "fullnameOverride: payments-api-eyJ-shaped-but-not-a-token-identifier",
  "data: SGVsbG8gd29ybGQsIHRoaXMgaXMgbm90IGEgdG9rZW4gYXQgYWxs",
  "payload eyJhbGciOiJub25lIn0 alone is not a JWT",
  "use the sk- prefix only in examples; risk-free task-sk-list",
  "deployment sk-app-worker-v2-payments-queue",
  "service sk-batch-runner-2024-eu-west-1-blue",
  "helm upgrade sk-proj-ingest-v3-canary-rollout-7",
  "ASIA and ASIAN regions; ASIANPACIFICREGION",
];

const HOSTILE_UNITS: readonly string[] = [join("-----", "BEGIN RSA ", "PRIVATE KEY-----\n"), "eyJ", "eyJ-", "eyJa.", ".", "-", "_", join("gh", "p_"), "eyJaaaaaaaa.bbbbbbbb.", join("s", "k-"), "http://a:"];
const MAX_DIFF_BYTES = 180 * 1024;
const hostile = (unit: string): string => unit.repeat(Math.ceil(MAX_DIFF_BYTES / unit.length)).slice(0, MAX_DIFF_BYTES);

/** Frozen copy of `sanitizeFridayOutput` before the shared set (Phase 0B A2) was added. */
function legacySanitize(value: unknown): string {
  let output = String(value ?? "")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "[REDACTED]");
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bOpenClaw\b/gi, "Friday runtime"],
    [/\b(?:openai\/)?gpt-5\.6-(?:luna|terra|sol)\b/gi, "Friday"],
    [/\b(?:Luna|Terra|Sol)\s+(?:agent|classifier|router|model)\b/gi, "Friday"],
    [/\bLangGraph\b/gi, "workflow engine"],
    [/\bChatGPT\/?Codex OAuth\b/gi, "internal authentication"],
    [/\bCodex OAuth\b/gi, "internal authentication"],
    [/\bfriday_[a-z0-9_]+\b/gi, "internal capability"],
    [/(?:\/Users\/|\/home\/)[^/\s`'"<>]+\/(?:[^\s`'"<>]|\\ )+/g, "[internal path]"],
    [/\bTrivy\b/gi, "security analysis"],
    [/\bkubeconform\b/gi, "Kubernetes schema validation"],
    [/\bTFLint\b/gi, "Terraform static analysis"],
  ];
  for (const [pattern, replacement] of replacements) output = output.replace(pattern, replacement);
  return output;
}

const MARKER = /\[REDACTED\]/g;

test("sanitizeFridayOutput removes every shared credential family in every context", () => {
  for (const { family, value, secret } of FAMILIES) {
    for (const context of CONTEXTS) {
      const output = sanitizeFridayOutput(context(value));
      assert.ok(!output.includes(secret), `${family} leaked: ${output}`);
      assert.match(output, /\[REDACTED\]/);
    }
  }
});

test("sanitizeFridayOutput never narrows its previous output", () => {
  for (const { family, value } of FAMILIES) {
    for (const context of [...CONTEXTS, (inner: string) => `OpenClaw via friday_git_review said ${inner}`]) {
      const input = context(value);
      const before = legacySanitize(input);
      const after = sanitizeFridayOutput(input);
      assert.ok((after.match(MARKER) ?? []).length >= (before.match(MARKER) ?? []).length, `${family}: fewer markers`);
      for (const token of input.split(/[\s"=:?&{},]+/u)) {
        if (token && !before.includes(token)) assert.ok(!after.includes(token), `${family}: re-exposed ${token}`);
      }
    }
  }
});

test("sanitizeFridayOutput keeps internal-name replacements", () => {
  assert.equal(sanitizeFridayOutput("OpenClaw ran Trivy"), "Friday runtime ran security analysis");
});

test("sanitizeFridayOutput leaves the false-positive corpus byte-identical", () => {
  for (const value of FALSE_POSITIVE_CORPUS) {
    assert.equal(sanitizeFridayOutput(value), value);
    assert.equal(sanitizeFridayOutput(value), legacySanitize(value));
  }
});

test("sanitizeFridayOutput stays bounded on a hostile 180 KiB input", () => {
  for (const unit of HOSTILE_UNITS) {
    const started = performance.now();
    sanitizeFridayOutput(hostile(unit));
    assert.ok(performance.now() - started < 1_000, `slow on ${JSON.stringify(unit)}`);
  }
});

test("sanitizeFridayOutput redacts only the block when a private key has an END line", () => {
  const input = `before ${FAMILIES[0]?.value} after`;
  const output = sanitizeFridayOutput(input);
  assert.ok(output.startsWith("before [REDACTED") && output.endsWith("] after"), output);
});
