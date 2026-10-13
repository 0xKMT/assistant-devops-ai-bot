import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLocalErrorRecord } from "../local-error-log.js";

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

/** Frozen copy of `redactCredentials` before the shared set (Phase 0B A2) was added. */
function legacyRedactCredentials(value: string): string {
  return value
    .replace(/(\bauthorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/giu, "$1[REDACTED]")
    .replace(/(\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD)\s*[=:]\s*["']?)[^\s,;"']+/giu, "$1[REDACTED]")
    .replace(/(\bcookie\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access_token|password|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{1,250}/gu, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{1,255}/gu, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{1,255}/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{7,4093}\.[A-Za-z0-9_-]{0,8192}(?:\.[A-Za-z0-9_-]{0,4096})?/gu, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{1,16}\b/gu, "[REDACTED]");
}

const MARKER = /\[REDACTED\]/g;

async function redactViaLog(inputs: readonly string[]): Promise<string[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "friday-shared-redaction-"));
  try {
    for (const errorMessage of inputs) await appendLocalErrorRecord({ operation: "docs_fetch", errorMessage }, { directory });
    const contents = await readFile(path.join(directory, "errors.ndjson"), "utf8");
    return contents.trim().split("\n").map((line) => String((JSON.parse(line) as Record<string, unknown>).errorMessage));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("local error log removes every shared credential family in every context", async () => {
  for (const context of CONTEXTS) {
    const outputs = await redactViaLog(FAMILIES.map(({ value }) => context(value)));
    FAMILIES.forEach(({ family, secret }, index) => {
      assert.ok(!outputs[index]?.includes(secret), `${family} leaked: ${outputs[index]}`);
      assert.match(outputs[index] ?? "", /\[REDACTED\]/);
    });
  }
});

test("local error log never narrows its previous redaction", async () => {
  for (const context of CONTEXTS) {
    const inputs = FAMILIES.map(({ value }) => context(value));
    const outputs = await redactViaLog(inputs);
    inputs.forEach((input, index) => {
      const before = legacyRedactCredentials(input);
      const after = outputs[index] ?? "";
      const family = FAMILIES[index]?.family;
      assert.ok((after.match(MARKER) ?? []).length >= (before.match(MARKER) ?? []).length, `${family}: fewer markers`);
      for (const token of input.split(/[\s"=:?&{},]+/u)) {
        if (token && !before.includes(token)) assert.ok(!after.includes(token), `${family}: re-exposed ${token}`);
      }
    });
  }
});

test("local error log keeps its loose rules for tokens cut at the excerpt cap", async () => {
  const cut = [join("gh", "p_", "a"), join("xo", "xb-", "a"), join("ey", "J", body(7), ".")];
  const outputs = await redactViaLog(cut);
  cut.forEach((value, index) => assert.equal(outputs[index], legacyRedactCredentials(value)));
});

test("local error log leaves the false-positive corpus as before", async () => {
  const outputs = await redactViaLog(FALSE_POSITIVE_CORPUS);
  // The loose `sk-` rule is kept on purpose, so equality is with the legacy
  // output rather than the input.
  FALSE_POSITIVE_CORPUS.forEach((value, index) => assert.equal(outputs[index], legacyRedactCredentials(value)));
});

test("local error log stays bounded on a hostile 180 KiB input", async () => {
  for (const unit of HOSTILE_UNITS) {
    const started = performance.now();
    await redactViaLog([hostile(unit)]);
    assert.ok(performance.now() - started < 1_000, `slow on ${JSON.stringify(unit)}`);
  }
});

test("local error log redacts only the block when a private key has an END line", async () => {
  const input = `before ${FAMILIES[0]?.value} after`;
  const output = (await redactViaLog([input]))[0] ?? "";
  assert.ok(output.startsWith("before [REDACTED") && output.endsWith("] after"), output);
});
