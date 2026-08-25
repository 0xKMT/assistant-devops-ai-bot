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
