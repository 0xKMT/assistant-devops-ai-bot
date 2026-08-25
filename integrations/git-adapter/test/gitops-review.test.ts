import test from "node:test";
import assert from "node:assert/strict";
import { parseKubeconformJson, scanDatadogServiceCatalogPolicy, scanGitOpsInvariants, scanGitOpsPolicy } from "../gitops-review.js";

const corpus = [
  { id: "literal-password", expect: true, source: "password: synthetic-password" },
  { id: "literal-api-token", expect: true, source: "api_token: synthetic-token" },
  { id: "literal-private-key", expect: true, source: "private_key: synthetic-key" },
  { id: "env-password", expect: true, source: "- name: POSTGRES_PASSWORD\n  value: synthetic-password" },
  { id: "env-api-key", expect: true, source: "- name: API_KEY\n  value: synthetic-key" },
  { id: "latest-image", expect: true, source: "image: example/service:latest" },
  { id: "privileged", expect: true, source: "privileged: true" },
  { id: "allow-escalation", expect: true, source: "allowPrivilegeEscalation: true" },
  { id: "host-network", expect: true, source: "hostNetwork: true" },
  { id: "root-container", expect: true, source: "runAsNonRoot: false" },
  { id: "secret-key-ref", expect: false, source: "secretKeyRef:\n  name: database-secret\n  key: password" },
  { id: "external-secret-name", expect: false, source: "secretName: database-secret" },
  { id: "secret-store-ref", expect: false, source: "secretStoreRef:\n  name: aws-secretsmanager" },
  { id: "helm-value", expect: false, source: "password: '{{ .Values.database.password }}'" },
  { id: "environment-reference", expect: false, source: "- name: POSTGRES_PASSWORD\n  valueFrom:\n    secretKeyRef:\n      name: db" },
  { id: "immutable-tag", expect: false, source: "image: example/service:2026.08.05" },
  { id: "digest-image", expect: false, source: "image: example/service@sha256:aaaaaaaa" },
  { id: "non-root", expect: false, source: "runAsNonRoot: true" },
  { id: "comment", expect: false, source: "# password: synthetic-password" },
  { id: "normal-secret-enabled-flag", expect: false, source: "externalSecretEnabled: true" },
] as const;

test("Target-Aware GitOps Review Engine v2 policy corpus contains 20 cases", () => {
  assert.equal(corpus.length, 20);
});

for (const fixture of corpus) {
  test(`GitOps policy corpus: ${fixture.id}`, () => {
    const added = new Set(fixture.source.split("\n").map((_line, index) => index + 1));
    const findings = scanGitOpsPolicy("chart/service/values.yaml", fixture.source, added);
    assert.equal(findings.length > 0, fixture.expect);
    if (fixture.expect) {
      assert.ok(findings.every((finding) => finding.addedInPullRequest));
      assert.doesNotMatch(JSON.stringify(findings), /synthetic-(?:password|token|key)/);
    }
  });
}

test("parses invalid kubeconform resources without copying manifest content", () => {
  const findings = parseKubeconformJson(JSON.stringify({
    resources: [{
      filename: "rendered.yaml",
      kind: "Deployment",
      name: "api",
      status: "statusInvalid",
      msg: "spec.template.spec.containers: Invalid type. Expected array",
      manifest: "password: credential-that-must-not-leak",
    }],
  }), "chart/service/api");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "HIGH");
  assert.doesNotMatch(JSON.stringify(findings), /credential-that-must-not-leak/);
});

test("ignores valid and missing-schema kubeconform resources", () => {
  const findings = parseKubeconformJson(JSON.stringify({
    resources: [
      { kind: "Deployment", status: "statusValid" },
      { kind: "VirtualService", status: "statusSkipped" },
    ],
  }), "chart/service/api");
  assert.equal(findings.length, 0);
});

test("blocks an invalid HPA range on added lines", () => {
  const source = "minReplicas: 6\nmaxReplicas: 3\nreplicas: 4";
  const findings = scanGitOpsInvariants("values/prd.yaml", source, new Set([1, 2]));
  assert.equal(findings[0]?.id, "FRIDAY-GITOPS-HPA-001");
  assert.equal(findings[0]?.severity, "HIGH");
  assert.equal(findings[0]?.addedInPullRequest, true);
});

test("warns when desired replicas is outside a valid HPA range", () => {
  const findings = scanGitOpsInvariants("values/prd.yaml", "minReplicas: 2\nmaxReplicas: 5\nreplicas: 1", new Set([3]));
  assert.equal(findings[0]?.id, "FRIDAY-GITOPS-HPA-002");
  assert.equal(findings[0]?.severity, "MEDIUM");
});

test("Datadog Service Catalog policy accepts a complete v3 entity", () => {
  const source = `apiVersion: v3
kind: service
metadata:
  name: api-dev
  owner: platform
  tags:
    - env:dev`;
  assert.deepEqual(scanDatadogServiceCatalogPolicy(
    "services-catalog/dev/api/entity.datadog.yaml",
    source,
    new Set([1, 2, 3, 4, 5, 6, 7]),
  ), []);
});

test("Datadog Service Catalog policy warns for an unowned skeletal entry", () => {
  const source = `apiVersion: v3
kind: service
metadata:
  name: api-dev
# owner: TEAM_HANDLE
# tags:
#   - env:dev`;
  const findings = scanDatadogServiceCatalogPolicy(
    "services-catalog/dev/api/entity.datadog.yaml",
    source,
    new Set([1, 2, 3, 4]),
  );
  assert.deepEqual(findings.map(({ id }) => id), ["FRIDAY-DATADOG-OWNER-001", "FRIDAY-DATADOG-ENV-001"]);
  assert.ok(findings.every(({ severity }) => severity === "MEDIUM"));
  assert.ok(findings.every(({ addedInPullRequest }) => addedInPullRequest));
});

test("Datadog Service Catalog policy blocks schema errors, active placeholders and environment mismatch", () => {
  const source = `apiVersion: v2.2
kind: application
metadata:
  name: api-dev
  owner: TEAM_HANDLE
  tags:
    - env:prd`;
  const findings = scanDatadogServiceCatalogPolicy(
    "services-catalog/dev/api/entity.datadog.yaml",
    source,
    new Set([1, 2, 3, 4, 5, 6, 7]),
  );
  assert.deepEqual(new Set(findings.map(({ id }) => id)), new Set([
    "FRIDAY-DATADOG-SCHEMA-001",
    "FRIDAY-DATADOG-SCHEMA-002",
    "FRIDAY-DATADOG-PLACEHOLDER-001",
    "FRIDAY-DATADOG-ENV-002",
  ]));
  assert.ok(findings.every(({ severity }) => severity === "HIGH"));
});

test("Datadog policy ignores similarly named generic YAML files", () => {
  assert.deepEqual(scanDatadogServiceCatalogPolicy("config/service.yaml", "apiVersion: v1", new Set([1])), []);
});
