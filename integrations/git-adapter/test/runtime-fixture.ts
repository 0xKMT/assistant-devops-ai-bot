import { configureReviewRuntime } from "../runtime-config.js";

export const TEST_REPOSITORIES = [
  ["example-org/platform-infrastructure", "develop"],
  ["example-org/cloud-infrastructure", "develop"],
  ["example-org/access-management", "main"],
  ["example-org/gitops", "main"],
  ["example-org/kubernetes-infrastructure", "develop"],
] as const;

export function configureTestRuntime(): void {
  configureReviewRuntime({
    repositories: TEST_REPOSITORIES.map(([slug, baseBranch]) => ({
      slug, baseBranch, root: `/tmp/friday-test/${slug.split("/")[1]}`,
      remoteUrl: `https://github.com/${slug}.git`,
    })),
    binaries: {
      git: "/usr/bin/git", gh: "/usr/bin/false", ssh: "/usr/bin/ssh",
      tflint: "/usr/bin/false", trivy: "/usr/bin/false", helm: "/usr/bin/false",
      kustomize: "/usr/bin/false", kubeconform: "/usr/bin/false",
    },
    storage: { cacheDir: "/tmp/friday-test/cache" },
    process: { home: "/tmp/friday-test/home", path: "/usr/bin:/bin" },
  });
}
