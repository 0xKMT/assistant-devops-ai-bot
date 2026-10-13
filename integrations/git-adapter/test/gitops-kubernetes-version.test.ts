import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PullRequestSnapshot } from "../core.js";
import { reviewGitOpsPullRequest } from "../gitops-review.js";
import { commandRunner, type ProcessOutput, type ProcessRequest } from "../process-runner.js";
import { configureReviewRuntime } from "../runtime-config.js";
import { reviewUnifiedPullRequest } from "../unified-review.js";

const DEFAULT_SLUG = "example-org/gitops";
const OVERRIDE_SLUG = "example-org/kubernetes-infrastructure";
const OVERRIDE_VERSION = "1.31.4";
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const RENDERED = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: friday-review\n";
const CHART_FILES: Readonly<Record<string, string>> = {
  "charts/app/Chart.yaml": "apiVersion: v2\nname: app\nversion: 0.1.0\n",
  "charts/app/values.yaml": "replicaCount: 3\n",
  "charts/app/templates/configmap.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\n",
};
const VALUES_DIFF = [
  "diff --git a/charts/app/values.yaml b/charts/app/values.yaml",
  "--- a/charts/app/values.yaml",
  "+++ b/charts/app/values.yaml",
  "@@ -1 +1 @@",
  "-replicaCount: 2",
  "+replicaCount: 3",
].join("\n");

interface Recorded {
  readonly tool: "helm" | "kubeconform";
  readonly args: readonly string[];
}

function output(stdout = "", exitCode = 0): ProcessOutput {
  return { stdout, stderr: "", exitCode, timedOut: false, truncated: false, durationMs: 0 };
}

/**
 * Builds an isolated runtime whose helm/kubeconform exist on disk, plus a fake
 * runner that answers the fixed Git argv used by preparePullRequest and
 * materializeSnapshot and records every helm/kubeconform invocation.
 */
async function harness(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "friday-k8s-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const helm = path.join(bin, "helm");
  const kubeconform = path.join(bin, "kubeconform");
  await writeFile(helm, "");
  await writeFile(kubeconform, "");
  configureReviewRuntime({
    repositories: [
      { slug: DEFAULT_SLUG, baseBranch: "main", root: path.join(root, "repos", "gitops"), remoteUrl: `https://github.com/${DEFAULT_SLUG}.git` },
      {
        slug: OVERRIDE_SLUG, baseBranch: "develop", root: path.join(root, "repos", "k8s"),
        remoteUrl: `https://github.com/${OVERRIDE_SLUG}.git`, kubernetesVersion: OVERRIDE_VERSION,
      },
    ],
    binaries: {
      git: path.join(bin, "git"), gh: path.join(bin, "gh"), ssh: path.join(bin, "ssh"),
      tflint: path.join(bin, "missing-tflint"), trivy: path.join(bin, "missing-trivy"), helm,
      kustomize: path.join(bin, "missing-kustomize"), kubeconform,
    },
    storage: { cacheDir: path.join(root, "cache") },
    process: { home: path.join(root, "home"), path: "/usr/bin:/bin" },
  });

  const recorded: Recorded[] = [];
  t.mock.method(commandRunner, "run", async (request: ProcessRequest): Promise<ProcessOutput> => {
    const args = [...request.args];
    if (request.file === helm) {
      recorded.push({ tool: "helm", args });
      return output(args[0] === "template" ? RENDERED : "");
    }
    if (request.file === kubeconform) {
      recorded.push({ tool: "kubeconform", args });
      return output();
    }
    if (request.file.endsWith("/gh")) throw new Error("GitHub broker unavailable in tests.");
    if (!request.file.endsWith("/git")) throw new Error(`Unexpected binary ${path.basename(request.file)}.`);
    if (args.includes("init")) {
      const gitDir = args.at(-1) ?? "";
      await mkdir(gitDir, { recursive: true });
      await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
      return output();
    }
    if (args.includes("clone")) {
      await mkdir(args.at(-1) ?? "", { recursive: true });
      return output();
    }
    if (args.includes("checkout")) {
      const destination = args[args.indexOf("-C") + 1] ?? "";
      for (const [file, content] of Object.entries(CHART_FILES)) {
        await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
        await writeFile(path.join(destination, file), content);
      }
      return output();
    }
    if (args.includes("ls-remote")) {
      const branch = args.find((arg) => arg.startsWith("refs/heads/")) ?? "";
      const pull = args.find((arg) => arg.startsWith("refs/pull/")) ?? "";
      return output(`${BASE_SHA}\t${branch}\n${HEAD_SHA}\t${pull}\n`);
    }
    if (args.includes("rev-parse")) return output(`${String(args.at(-1)).includes("/pull/") ? HEAD_SHA : BASE_SHA}\n`);
    if (args.includes("merge-base")) return output(`${BASE_SHA}\n`);
    if (args.includes("log")) return output("abc1234 Raise app replicas\n");
    if (args.includes("--name-status")) return output("M\tcharts/app/values.yaml\n");
    if (args.includes("diff")) return output(`${VALUES_DIFF}\n`);
    return output();
  });

  /** Replaces the per-run temporary directory so argv can be compared exactly. */
  function normalized(): Recorded[] {
    return recorded.map(({ tool, args }) => ({
      tool,
      args: args.map((arg) => arg.replace(/^.*\/friday-gitops-review-[^/]+/, "<tmp>").replace(path.join(root, "cache"), "<cache>")),
    }));
  }
  return { recorded, normalized };
}

/** The exact argv produced before per-repository versions existed. */
function expectedArgv(version: string): Recorded[] {
  return [
    { tool: "helm", args: ["lint", "<tmp>/snapshot/charts/app", "--quiet", "--kube-version", version, "-f", "<tmp>/snapshot/charts/app/values.yaml"] },
    { tool: "helm", args: ["lint", "<tmp>/base-snapshot/charts/app", "--quiet", "--kube-version", version, "-f", "<tmp>/base-snapshot/charts/app/values.yaml"] },
    { tool: "helm", args: ["template", "friday-review", "<tmp>/snapshot/charts/app", "--include-crds", "--skip-tests", "--kube-version", version, "-f", "<tmp>/snapshot/charts/app/values.yaml"] },
    { tool: "helm", args: ["template", "friday-review", "<tmp>/base-snapshot/charts/app", "--include-crds", "--skip-tests", "--kube-version", version, "-f", "<tmp>/base-snapshot/charts/app/values.yaml"] },
    { tool: "kubeconform", args: ["-output", "json", "-strict", "-ignore-missing-schemas", "-kubernetes-version", version, "-cache", "<cache>/kubeconform", "<tmp>/helm-0.yaml"] },
  ];
}

// The friday_gitops_review tool entry (index.ts) calls
// reviewGitOpsPullRequest(params) with no prepared snapshot; this mirrors that
// call because the OpenClaw plugin SDK is an optional peer not installed here.
test("tool path keeps byte-identical helm and kubeconform argv for an unversioned repository", async (t) => {
  const { normalized } = await harness(t);
  const result = await reviewGitOpsPullRequest({ pullRequestUrl: `https://github.com/${DEFAULT_SLUG}/pull/7` });
  assert.equal(result.headSha, HEAD_SHA);
  assert.deepEqual(normalized(), expectedArgv("1.30.0"));
});

test("tool path passes a configured Kubernetes version to all five validator call sites", async (t) => {
  const { normalized } = await harness(t);
  await reviewGitOpsPullRequest({ pullRequestUrl: `https://github.com/${OVERRIDE_SLUG}/pull/7` });
  assert.deepEqual(normalized(), expectedArgv(OVERRIDE_VERSION));
});

test("unified review keeps byte-identical helm and kubeconform argv for an unversioned repository", async (t) => {
  const { normalized } = await harness(t);
  await reviewUnifiedPullRequest({ pullRequestUrl: `https://github.com/${DEFAULT_SLUG}/pull/7` });
  assert.deepEqual(normalized(), expectedArgv("1.30.0"));
});

test("unified review passes a configured Kubernetes version to all five validator call sites", async (t) => {
  const { normalized } = await harness(t);
  await reviewUnifiedPullRequest({ pullRequestUrl: `https://github.com/${OVERRIDE_SLUG}/pull/7` });
  assert.deepEqual(normalized(), expectedArgv(OVERRIDE_VERSION));
});

test("a cached snapshot without any version field reviews with the configured version", async (t) => {
  const { normalized } = await harness(t);
  // Shape of a snapshot persisted under friday-cache-v3:pr-snapshot before
  // per-repository versions existed: it carries no Kubernetes version at all.
  const cachedSnapshot = {
    repository: OVERRIDE_SLUG,
    pullRequest: 7,
    baseBranch: "develop",
    mergeBase: BASE_SHA,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    changedFiles: [{ status: "M", path: "charts/app/values.yaml" }],
    commits: ["abc1234 Raise app replicas"],
    terraformDiff: VALUES_DIFF,
    diffTruncated: false,
    safety: { workingTreeChanged: false, pushedRemoteChanges: false, fetchedInto: [], secretsRedacted: true },
  } as unknown as PullRequestSnapshot;
  assert.equal("kubernetesVersion" in cachedSnapshot, false);
  await reviewGitOpsPullRequest({ pullRequestUrl: `https://github.com/${OVERRIDE_SLUG}/pull/7` }, { snapshot: cachedSnapshot });
  assert.deepEqual(normalized(), expectedArgv(OVERRIDE_VERSION));
});
