import test from "node:test";
import assert from "node:assert/strict";
import { configureTestRuntime } from "./runtime-fixture.js";
import {
  buildPullRequestSnapshotCacheKey,
  buildGitHubReadBrokerRequest,
  capText,
  parseLsRemote,
  parsePullRequest,
  redact,
  repositoryGitCachePath,
  validateRelativePath,
} from "../core.js";

configureTestRuntime();

test("stores writable Git state in Friday cache, not in the mounted repository", () => {
  const repository = parsePullRequest("https://github.com/example-org/gitops/pull/206").repository;
  assert.equal(repository.root, "/tmp/friday-test/gitops");
  assert.equal(repositoryGitCachePath(repository), "/tmp/friday-test/cache/git/example-org--gitops.git");
  assert.equal(repositoryGitCachePath(repository).startsWith(repository.root), false);
});

test("GitHub OAuth broker emits only fixed GET requests for allowlisted repositories", () => {
  const repository = parsePullRequest("https://github.com/example-org/gitops/pull/206").repository;
  const args = buildGitHubReadBrokerRequest(repository, 206, "reviews");
  assert.deepEqual(args.slice(0, 3), ["api", "--method", "GET"]);
  assert.equal(args.at(-1), "repos/example-org/gitops/pulls/206/reviews?per_page=50");
  assert.equal(args.some((item) => /POST|PUT|PATCH|DELETE/.test(item)), false);
  assert.throws(() => buildGitHubReadBrokerRequest({ ...repository }, 206, "pull"), /outside.*allowlist/);
  assert.throws(() => buildGitHubReadBrokerRequest(repository, 0, "pull"), /Invalid pull-request/);
});

test("accepts only the allowlisted GitHub pull-request URL", () => {
  assert.equal(
    parsePullRequest("https://github.com/example-org/platform-infrastructure/pull/284").number,
    284,
  );
  assert.equal(
    parsePullRequest("https://github.com/example-org/cloud-infrastructure/pull/667").repository.slug,
    "example-org/cloud-infrastructure",
  );
  assert.equal(
    parsePullRequest("https://github.com/example-org/access-management/pull/12").repository.baseBranch,
    "main",
  );
  assert.equal(
    parsePullRequest("https://github.com/example-org/gitops/pull/34").repository.slug,
    "example-org/gitops",
  );
  assert.equal(
    parsePullRequest("https://github.com/example-org/kubernetes-infrastructure/pull/55").repository.baseBranch,
    "develop",
  );
  assert.throws(
    () => parsePullRequest("https://github.com/example-org/another-repo/pull/284"),
    /outside.*allowlist/,
  );
  assert.throws(
    () => parsePullRequest("https://example.com/example-org/platform-infrastructure/pull/284"),
    /Only HTTPS GitHub/,
  );
});

test("blocks traversal, state, caches and private keys", () => {
  assert.equal(validateRelativePath("components/service/main.tf"), "components/service/main.tf");
  assert.equal(validateRelativePath("charts/service/templates/deployment.yaml"), "charts/service/templates/deployment.yaml");
  assert.equal(validateRelativePath("charts/service/templates/_helpers.tpl"), "charts/service/templates/_helpers.tpl");
  assert.throws(() => validateRelativePath("../main.tf"), /traversal/);
  assert.throws(() => validateRelativePath(".git/config"), /metadata/);
  assert.throws(() => validateRelativePath("module/.terraform/providers.json"), /caches/);
  assert.throws(() => validateRelativePath("terraform.tfstate"), /secret or state/);
  assert.throws(() => validateRelativePath("certs/prod.key"), /Private-key/);
  assert.throws(() => validateRelativePath("scripts/deploy.sh"), /not allowlisted/);
});

test("redacts common credentials and literal secret assignments", () => {
  const awsKey = ["AK", "IA1234567890ABCDEF"].join("");
  const githubToken = ["gh", "p_123456789012345678901234567890"].join("");
  const slackToken = ["xo", "xb-123456789012-abcdefghijklmnop"].join("");
  const sample = [
    `access_key = "${awsKey}"`,
    `github_token = "${githubToken}"`,
    `slack = "${slackToken}"`,
    "password = \"plain-text-value\"",
    "secret_arn = var.secret_arn",
    "api_token: plain-yaml-token",
    "secretRef: {{ .Values.secretRef }}",
    "https://person:password@example.com/path",
  ].join("\n");
  const output = redact(sample);
  assert.equal(output.includes(awsKey), false);
  assert.doesNotMatch(output, /ghp_123/);
  assert.doesNotMatch(output, /xoxb-/);
  assert.doesNotMatch(output, /plain-text-value/);
  assert.match(output, /secret_arn = var\.secret_arn/);
  assert.doesNotMatch(output, /plain-yaml-token/);
  assert.match(output, /secretRef: \{\{ \.Values\.secretRef \}\}/);
  assert.doesNotMatch(output, /person:password/);
});

test("redacts sensitive ECS name/value pairs before model context", () => {
  const sample = [
    "environment = [{",
    "  name  = \"POSTGRES_PASSWORD\"",
    "  value = \"synthetic-password\"",
    "}]",
    "environment = [{ name = \"API_TOKEN\", value = \"${var.api_token}\" }]",
  ].join("\n");
  const output = redact(sample);
  assert.doesNotMatch(output, /synthetic-password/);
  assert.match(output, /value = "\[REDACTED_LITERAL\]"/);
  assert.match(output, /value = "\$\{var\.api_token\}"/);
});

test("redacts auth-like base64 and webhook literals", () => {
  const output = redact([
    "kialiAuth: syntheticBase64CredentialValue0123456789==",
    "alertWebhook: https://hooks.slack.com/services/T000/B000/synthetic",
    "authRef: ${var.auth_ref}",
  ].join("\n"));
  assert.doesNotMatch(output, /syntheticBase64Credential/);
  assert.doesNotMatch(output, /hooks\.slack\.com/);
  assert.match(output, /authRef: \$\{var\.auth_ref\}/);
});

test("caps UTF-8 output", () => {
  const result = capText("abcdef", 3);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^abc/);
});

test("parses remote refs and keys snapshots by both base and PR head", () => {
  const refs = parseLsRemote([
    "1111111111111111111111111111111111111111\trefs/heads/develop",
    "2222222222222222222222222222222222222222\trefs/pull/667/head",
  ].join("\n"));
  assert.equal(refs.get("refs/heads/develop"), "1111111111111111111111111111111111111111");
  const baseSha = refs.get("refs/heads/develop");
  const headSha = refs.get("refs/pull/667/head");
  assert.ok(baseSha);
  assert.ok(headSha);
  const first = buildPullRequestSnapshotCacheKey({
    repository: "example-org/cloud-infrastructure",
    pullRequest: 667,
    baseSha,
    headSha,
  });
  const changedBase = buildPullRequestSnapshotCacheKey({
    repository: "example-org/cloud-infrastructure",
    pullRequest: 667,
    baseSha: "3333333333333333333333333333333333333333",
    headSha,
  });
  assert.notEqual(first, changedBase);
});
