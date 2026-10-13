import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewRuntimeConfig } from "../runtime-config.js";

const valid = {
  repositories: [{
    slug: "example/platform", root: "/srv/friday/repos/platform",
    remoteUrl: "https://github.com/example/platform.git", baseBranch: "main",
  }],
  binaries: {
    git: "/usr/bin/git", gh: "/usr/bin/gh", ssh: "/usr/bin/ssh", tflint: "/usr/bin/tflint",
    trivy: "/usr/bin/trivy", helm: "/usr/bin/helm", kustomize: "/usr/bin/kustomize",
    kubeconform: "/usr/bin/kubeconform",
  },
  storage: { cacheDir: "/var/cache/friday" },
  process: { home: "/var/lib/friday", path: "/usr/bin:/bin" },
};

test("accepts a portable host configuration without source-specific repositories", () => {
  const config = parseReviewRuntimeConfig(valid);
  assert.equal(config.repositories.get("example/platform")?.baseBranch, "main");
  assert.equal(config.binaries.helm, "/usr/bin/helm");
});

test("fails closed when repositories or execution paths are missing", () => {
  assert.throws(() => parseReviewRuntimeConfig({}), /at least one repository/);
  assert.throws(() => parseReviewRuntimeConfig({ ...valid, binaries: { ...valid.binaries, git: "git" } }), /absolute path/);
  assert.throws(() => parseReviewRuntimeConfig({ ...valid, repositories: [{ ...valid.repositories[0], remoteUrl: "ssh://github.com/example/platform" }] }), /HTTPS GitHub/);
});

test("rejects duplicate repositories case-insensitively", () => {
  assert.throws(() => parseReviewRuntimeConfig({
    ...valid,
    repositories: [valid.repositories[0], { ...valid.repositories[0], slug: "Example/Platform" }],
  }), /Duplicate repository/);
});

test("defaults each repository to Kubernetes 1.30.0 when no version is configured", () => {
  const config = parseReviewRuntimeConfig(valid);
  assert.equal(config.repositories.get("example/platform")?.kubernetesVersion, "1.30.0");
});

test("accepts a per-repository Kubernetes version override", () => {
  const config = parseReviewRuntimeConfig({
    ...valid,
    repositories: [{ ...valid.repositories[0], kubernetesVersion: "1.31.4" }],
  });
  assert.equal(config.repositories.get("example/platform")?.kubernetesVersion, "1.31.4");
});

test("rejects malformed Kubernetes versions at parse time", () => {
  for (const kubernetesVersion of [null, "", "v1.30.0", "1.30", "2.0.0", "1.300.0", "1.30.0 --debug", "1.30.0\n", " 1.30.0", 1.3]) {
    assert.throws(() => parseReviewRuntimeConfig({
      ...valid,
      repositories: [{ ...valid.repositories[0], kubernetesVersion }],
    }), /kubernetesVersion/, `accepted ${JSON.stringify(kubernetesVersion)}`);
  }
});
