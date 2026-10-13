import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../core.js";

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

/** Frozen copy of `redact` before the shared set (Phase 0B A2) was added. */
function legacyRedact(input: unknown): string {
  let value = String(input ?? "");
  value = value.replace(/\{[^{}]{0,4000}\}/gs, (block) => {
    const name = /["']?name["']?\s*[=:]\s*(["'])([^"'\n]+)\1/i.exec(block);
    if (!name || !/(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(name[2] ?? "")) {
      return block;
    }
    return block.replace(
      /(["']?value["']?\s*[=:]\s*)(["'])(?!\$\{|\{\{|var\.|local\.|module\.|data\.)([^"'\n]*)\2/i,
      "$1\"[REDACTED_LITERAL]\"",
    );
  });
  value = value.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  value = value.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");
  value = value.replace(/\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  value = value.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  value = value.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]");
  value = value.replace(/\bxapp-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]");
  value = value.replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "[REDACTED_SLACK_WEBHOOK]");
  value = value.replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@");
  value = value.replace(
    /(^[+\- ]?\s*[A-Za-z0-9_.-]*(?:auth|credential|webhook)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)(?!\$\{|\{\{|var\.|local\.|module\.|data\.)([A-Za-z0-9+/=_-]{20,}|https?:\/\/[^\s"']+)\2/gim,
    "$1\"[REDACTED_LITERAL]\"",
  );
  value = value.replace(
    /(^[+\- ]?\s*[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|auth|credential|webhook|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*\s*=\s*)(["'])(?!\$\{|var\.|local\.|module\.|data\.)([^"'\n]+)\2/gim,
    "$1\"[REDACTED_LITERAL]\"",
  );
  value = value.replace(
    /(^[+\- ]?\s*[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|auth|credential|webhook|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*\s*:)(?!\s*(?:[>|]\s*$|["']?(?:\$\{|\{\{|var\.|local\.|module\.|data\.)))(\s*)([^\n#]+)/gim,
    "$1$2[REDACTED_LITERAL]",
  );
  return value;
}

const MARKER = /\[REDACTED[A-Z_]*\]/g;

test("redact removes every shared credential family in every context", () => {
  for (const { family, value, secret } of FAMILIES) {
    for (const context of CONTEXTS) {
      const output = redact(context(value));
      assert.ok(!output.includes(secret), `${family} leaked: ${output}`);
      assert.match(output, /\[REDACTED_[A-Z_]+\]|\[REDACTED\]/);
    }
  }
});

test("redact never narrows its previous output", () => {
  for (const { family, value } of FAMILIES) {
    for (const context of CONTEXTS) {
      const input = context(value);
      const before = legacyRedact(input);
      const after = redact(input);
      assert.ok((after.match(MARKER) ?? []).length >= (before.match(MARKER) ?? []).length, `${family}: fewer markers`);
      for (const token of input.split(/[\s"=:?&{},]+/u)) {
        if (token && !before.includes(token)) assert.ok(!after.includes(token), `${family}: re-exposed ${token}`);
      }
    }
  }
});

test("redact labels shared-set matches so review snippets still see a marker", () => {
  assert.equal(redact(join("s", "k-", body(40))), "[REDACTED_CREDENTIAL]");
});

test("redact leaves the false-positive corpus byte-identical", () => {
  for (const value of FALSE_POSITIVE_CORPUS) {
    assert.equal(redact(value), value);
    assert.equal(redact(value), legacyRedact(value));
  }
});

test("redact stays bounded on a hostile 180 KiB diff", () => {
  for (const unit of HOSTILE_UNITS) {
    const started = performance.now();
    redact(hostile(unit));
    assert.ok(performance.now() - started < 1_000, `slow on ${JSON.stringify(unit)}`);
  }
});

test("redact redacts only the block when a private key has an END line", () => {
  const input = `before ${FAMILIES[0]?.value} after`;
  const output = redact(input);
  assert.ok(output.startsWith("before [REDACTED") && output.endsWith("] after"), output);
});
