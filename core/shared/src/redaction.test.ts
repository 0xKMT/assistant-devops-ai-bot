import test from "node:test";
import assert from "node:assert/strict";
import { redactCredentialShapes } from "./redaction.js";

// Synthetic values are assembled at runtime so the portability secret audit
// never sees a credential-shaped literal in source.
const join = (...parts: string[]): string => parts.join("");
const body = (length: number, seed = "aB3"): string => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

const FAMILIES: Readonly<Record<string, string>> = {
  privateKey: join("-----", "BEGIN RSA ", "PRIVATE KEY-----\n", body(64), "\n-----", "END RSA ", "PRIVATE KEY-----"),
  awsAkia: join("AK", "IA", body(16, "Q7")),
  awsAsia: join("AS", "IA", body(16, "Z9")),
  ghp: join("gh", "p_", body(36)),
  gho: join("gh", "o_", body(36)),
  ghu: join("gh", "u_", body(36)),
  ghs: join("gh", "s_", body(36)),
  ghr: join("gh", "r_", body(36)),
  githubPat: join("github", "_pat_", body(60)),
  slackBot: join("xo", "xb-", body(30, "1a-")),
  slackUser: join("xo", "xp-", body(30, "1a-")),
  slackApp: join("xa", "pp-", body(30, "1a-")),
  slackWebhook: join("https://hooks.", "slack.com/services/", "T0000/B0000/", body(24)),
  openAiKey: join("s", "k-", body(40)),
  openAiProjectKey: join("s", "k-proj-", body(40)),
  jwt: join("ey", "J", body(20), ".", "ey", "J", body(40), ".", body(43, "x_9")),
  urlUserinfo: join("https://deploy", ":", body(16), "@", "example.invalid/repo.git"),
};

const SECRET_PART: Readonly<Record<string, string>> = {
  ...FAMILIES,
  urlUserinfo: body(16),
};

/** Values that look token-ish but are not credentials and must survive intact. */
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
  "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.",
  "use the sk- prefix only in examples; risk-free task-sk-list",
  "deployment sk-app-worker-v2-payments-queue",
  "service sk-batch-runner-2024-eu-west-1-blue",
  "helm upgrade sk-proj-ingest-v3-canary-rollout-7",
  "ASIA and ASIAN regions; ASIANPACIFICREGION",
];

test("removes every credential family", () => {
  for (const [family, value] of Object.entries(FAMILIES)) {
    const output = redactCredentialShapes(`before ${value} after`);
    assert.ok(!output.includes(SECRET_PART[family] ?? value), `${family} leaked: ${output}`);
    assert.ok(output.includes("[REDACTED]"), `${family} not marked`);
    assert.ok(output.startsWith("before ") && output.endsWith(" after"), `${family} damaged context`);
  }
});

test("uses the caller's replacement label", () => {
  assert.equal(redactCredentialShapes(FAMILIES.ghp ?? "", "[X]"), "[X]");
  assert.equal(
    redactCredentialShapes(FAMILIES.urlUserinfo ?? "", "[X]"),
    "https://[X]@example.invalid/repo.git",
  );
});

test("an overlong token still loses its prefix", () => {
  const output = redactCredentialShapes(join("gh", "p_", body(400)));
  assert.ok(output.startsWith("[REDACTED]"));
});

test("leaves the false-positive corpus byte-identical", () => {
  for (const value of FALSE_POSITIVE_CORPUS) assert.equal(redactCredentialShapes(value), value);
});

test("stays bounded on a hostile 180 KiB input", () => {
  const size = 180 * 1024;
  const units = [join("-----", "BEGIN RSA ", "PRIVATE KEY-----\n"), "eyJ", "eyJ-", "eyJa.", ".", "-", "_", join("gh", "p_"), "eyJaaaaaaaa.bbbbbbbb.", "s" + "k-", "http://a:"];
  for (const unit of units) {
    const input = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const started = performance.now();
    redactCredentialShapes(input);
    assert.ok(performance.now() - started < 1_000, `slow on ${JSON.stringify(unit)}`);
  }
});

test("redacts each private-key block separately and keeps text between them", () => {
  const key = FAMILIES.privateKey ?? "";
  assert.equal(redactCredentialShapes(`a ${key} b ${key} c`), "a [REDACTED] b [REDACTED] c");
  const header = join("-----", "BEGIN ", "PRIVATE KEY-----");
  // Like a lazy match, a header pairs with the nearest END line after it.
  assert.equal(redactCredentialShapes(`x ${header} stray ${header}\n${key} y`), "x [REDACTED] y");
  assert.equal(redactCredentialShapes(`kept ${header}\n${body(64)}`), "kept [REDACTED]");
});
