/**
 * Controlled Git/GitHub read boundary and PR snapshot preparation.
 * All repository access is allowlisted, output-bounded and redacted; this file
 * intentionally exposes no checkout, commit, push or arbitrary API primitive.
 */
import type {
  FridayRepositorySlug,
  GitReadFileParams,
  SafetyEnvelope,
} from "@friday/shared";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { commandRunner } from "./process-runner.js";
import {
  resolveConfiguredRepository,
  reviewRuntime,
  type RepositoryConfig,
} from "./runtime-config.js";
import type { SnapshotStore } from "./sqlite-store.js";
export type { RepositoryConfig } from "./runtime-config.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface RunCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

interface ChangedFile {
  readonly status: string;
  readonly path: string;
  readonly previousPath?: string;
}

export interface PullRequestExternalContext {
  readonly source: "github-cli-oauth-broker" | "git-only";
  readonly title?: string;
  readonly bodySummary?: string;
  readonly draft?: boolean;
  readonly state?: string;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
  readonly reviews: readonly { readonly state: string; readonly summary?: string }[];
  readonly unavailableReason?: string;
  readonly untrusted: true;
}

export interface PullRequestSnapshot {
  readonly repository: FridayRepositorySlug;
  readonly pullRequest: number;
  readonly baseBranch: string;
  readonly mergeBase: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedFiles: ChangedFile[];
  readonly commits: string[];
  readonly pullRequestContext?: PullRequestExternalContext;
  readonly terraformDiff: string;
  readonly diffTruncated: boolean;
  readonly safety: SafetyEnvelope & { readonly fetchedInto: readonly string[] };
}

/** Redacted, bounded PR-head file context for internal snippet selection only. */
export interface PullRequestFileContext {
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
  readonly secretsRedacted: true;
}

export interface SnapshotCacheEntry {
  readonly createdAt: number;
  readonly snapshot: PullRequestSnapshot;
  readonly exactKey?: string;
}

interface SnapshotCacheMetadataOptions {
  readonly hit: boolean;
  readonly key: string;
  readonly createdAt: number;
  readonly now: number;
  readonly validatedByRemoteRefs: boolean;
  readonly validation: string;
  readonly maxStalenessMs?: number;
}

const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 180 * 1024;
const MAX_FILE_BYTES = 80 * 1024;
export const PR_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const PR_HOT_CACHE_TTL_MS = 60 * 1000;
const ALLOWED_FILE_EXTENSIONS = new Set([
  ".tf",
  ".tfvars",
  ".hcl",
  ".json",
  ".yaml",
  ".yml",
  ".tpl",
  ".gotmpl",
  ".md",
]);

export function runCommand(
  file: string,
  args: readonly string[],
  { cwd, timeoutMs = 45_000, env: extraEnv = {} }: RunCommandOptions = {},
): Promise<CommandResult> {
  return commandRunner.run({
    file, args, ...(cwd ? { cwd } : {}), timeoutMs, maxBytes: MAX_COMMAND_BYTES, env: extraEnv,
    rejectOnFailure: true, redactError: redact,
  }).then(({ stdout, stderr, truncated }) => ({ stdout, stderr, truncated }));
}

interface GitHubPullResponse {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly draft?: unknown;
  readonly state?: unknown;
  readonly labels?: readonly { readonly name?: unknown }[];
}

function safeContextText(value: unknown, maxBytes: number): string {
  return capText(redact(String(value ?? "")).trim(), maxBytes).text;
}

function parseJsonArray(value: string): readonly Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

export type GitHubReadOperation = "pull" | "comments" | "reviews";

export function buildGitHubReadBrokerRequest(
  repository: RepositoryConfig,
  pullRequest: number,
  operation: GitHubReadOperation,
): readonly string[] {
  if (reviewRuntime().repositories.get(repository.slug.toLowerCase()) !== repository) {
    throw new Error("Repository is outside Friday's GitHub read broker allowlist.");
  }
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1 || pullRequest > 10_000_000) {
    throw new Error("Invalid pull-request number for GitHub read broker.");
  }
  const base = `repos/${repository.slug}`;
  const endpoint = operation === "pull"
    ? `${base}/pulls/${pullRequest}`
    : operation === "comments"
      ? `${base}/issues/${pullRequest}/comments?per_page=50`
      : `${base}/pulls/${pullRequest}/reviews?per_page=50`;
  return [
    "api",
    "--method", "GET",
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2022-11-28",
    endpoint,
  ];
}

async function githubBrokerGet(
  repository: RepositoryConfig,
  pullRequest: number,
  operation: GitHubReadOperation,
): Promise<string> {
  const result = await runCommand(reviewRuntime().binaries.gh, buildGitHubReadBrokerRequest(repository, pullRequest, operation), {
    timeoutMs: 20_000,
    env: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
  });
  return result.stdout;
}

export async function fetchPullRequestExternalContext(
  repository: RepositoryConfig,
  pullRequest: number,
): Promise<PullRequestExternalContext> {
  try {
    const [pull, comments, reviews] = await Promise.all([
      githubBrokerGet(repository, pullRequest, "pull"),
      githubBrokerGet(repository, pullRequest, "comments"),
      githubBrokerGet(repository, pullRequest, "reviews"),
    ]);
    const metadata = JSON.parse(pull) as GitHubPullResponse;
    const commentSummaries = parseJsonArray(comments)
      .map((item) => safeContextText(item.body, 600))
      .filter(Boolean)
      .slice(-20);
    const reviewSummaries = parseJsonArray(reviews)
      .map((item) => ({
        state: safeContextText(item.state, 40).toUpperCase() || "COMMENTED",
        ...(safeContextText(item.body, 600) ? { summary: safeContextText(item.body, 600) } : {}),
      }))
      .slice(-20);
    return {
      source: "github-cli-oauth-broker",
      title: safeContextText(metadata.title, 500),
      bodySummary: safeContextText(metadata.body, 6_000),
      draft: metadata.draft === true,
      state: safeContextText(metadata.state, 40).toLowerCase(),
      labels: (metadata.labels ?? []).map((label) => safeContextText(label.name, 100)).filter(Boolean).slice(0, 20),
      comments: commentSummaries,
      reviews: reviewSummaries,
      untrusted: true,
    };
  } catch {
    return {
      source: "git-only",
      labels: [],
      comments: [],
      reviews: [],
      unavailableReason: "GitHub metadata could not be read through Friday's bounded read-only broker; commit and diff context remain available.",
      untrusted: true,
    };
  }
}

export function parsePullRequest(value: unknown): { repository: RepositoryConfig; number: number } {
  const text = String(value ?? "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("A full allowlisted GitHub pull-request URL is required.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only HTTPS GitHub pull-request URLs are allowed.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2]?.toLowerCase() !== "pull") {
    throw new Error("A full allowlisted GitHub pull-request URL is required.");
  }
  const owner = parts[0];
  const repositoryName = parts[1];
  if (!owner || !repositoryName) throw new Error("A full allowlisted GitHub pull-request URL is required.");
  const requestedSlug = `${owner}/${repositoryName}`;
  const repository = resolveConfiguredRepository(requestedSlug);
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000) {
    throw new Error("Invalid pull-request number.");
  }
  return { repository, number };
}

export function resolveRepository(slug: unknown): RepositoryConfig {
  return resolveConfiguredRepository(slug);
}

export function validateRelativePath(value: unknown): string {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.includes("\0")) {
    throw new Error("A repository-relative file path is required.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Path traversal and ambiguous path components are not allowed.");
  }
  if (parts.includes(".git") || parts.includes(".terraform")) {
    throw new Error("Git metadata and Terraform caches are not readable.");
  }
  const lower = path.toLowerCase();
  const blockedNames = [".env", "terraform.tfstate", "terraform.tfstate.backup", "credentials"];
  if (blockedNames.some((name) => lower === name || lower.endsWith(`/${name}`))) {
    throw new Error("Potential secret or state files are blocked.");
  }
  if (lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12")) {
    throw new Error("Private-key material is blocked.");
  }
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot) : "";
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`File extension ${extension || "(none)"} is not allowlisted.`);
  }
  return path;
}

function redactSensitiveNameValuePairs(input: string): string {
  return input.replace(/\{[^{}]{0,4000}\}/gs, (block) => {
    const name = /["']?name["']?\s*[=:]\s*(["'])([^"'\n]+)\1/i.exec(block);
    if (!name || !/(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(name[2] ?? "")) {
      return block;
    }
    return block.replace(
      /(["']?value["']?\s*[=:]\s*)(["'])(?!\$\{|\{\{|var\.|local\.|module\.|data\.)([^"'\n]*)\2/i,
      "$1\"[REDACTED_LITERAL]\"",
    );
  });
}

export function redact(input: unknown): string {
  let value = String(input ?? "");
  value = redactSensitiveNameValuePairs(value);
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

export function capText(input: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(String(input ?? ""), "utf8");
  if (buffer.length <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`,
    truncated: true,
  };
}

function parseChangedFiles(nameStatus: string): ChangedFile[] {
  return nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line): ChangedFile => {
      const columns = line.split("\t");
      const status = columns[0];
      const filePath = columns.at(-1);
      if (!status || !filePath) throw new Error("Git returned an invalid changed-file record.");
      return {
        status,
        path: filePath,
        ...(columns.length > 2 && columns[1] ? { previousPath: columns[1] } : {}),
      };
    });
}

const repositoryLocks = new Map<string, Promise<void>>();

/** Returns Friday's private writable bare repository, never the mounted source tree. */
export function repositoryGitCachePath(repository: RepositoryConfig): string {
  return path.join(reviewRuntime().storage.cacheDir, "git", `${repository.slug.replace("/", "--")}.git`);
}

async function withRepositoryLock<T>(repository: RepositoryConfig, operation: () => Promise<T>): Promise<T> {
  const key = repository.slug.toLowerCase();
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  repositoryLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryLocks.get(key) === queued) repositoryLocks.delete(key);
  }
}

async function ensureGitCache(repository: RepositoryConfig): Promise<string> {
  const runtime = reviewRuntime();
  const gitRoot = path.join(runtime.storage.cacheDir, "git");
  const gitDir = repositoryGitCachePath(repository);
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  const rootStatus = await lstat(gitRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("Friday Git cache root must be a real directory.");
  }
  const head = await lstat(path.join(gitDir, "HEAD")).catch(() => undefined);
  if (!head) {
    await runCommand(runtime.binaries.git, ["init", "--bare", "--quiet", gitDir], { cwd: gitRoot });
  } else if (!head.isFile()) {
    throw new Error("Friday Git cache is not a valid bare repository.");
  }
  return gitDir;
}

async function git(repository: RepositoryConfig, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  // Keep authentication scoped to this child process. The adapter still
  // exposes only fixed read-only Git operations and never changes global Git
  // configuration or reads the OAuth token into Friday's process.
  const runtime = reviewRuntime();
  const gitDir = await ensureGitCache(repository);
  return runCommand(runtime.binaries.git, [
    "-c",
    `credential.helper=!${runtime.binaries.gh} auth git-credential`,
    "-c",
    "core.hooksPath=/dev/null",
    "--git-dir",
    gitDir,
    ...args,
  ], {
    ...options,
    cwd: repository.root,
    env: {
      GIT_SSH_COMMAND: `${runtime.binaries.ssh} -o BatchMode=yes -o ConnectTimeout=15`,
      ...options.env,
    },
  });
}

export function parseLsRemote(output: unknown): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of String(output ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (sha && /^[a-f0-9]{40}$/i.test(sha) && ref?.startsWith("refs/")) refs.set(ref, sha.toLowerCase());
  }
  return refs;
}

export function buildPullRequestSnapshotCacheKey({
  repository,
  pullRequest,
  baseSha,
  headSha,
}: {
  readonly repository: string;
  readonly pullRequest: number;
  readonly baseSha: string;
  readonly headSha: string;
}): string {
  if (!repository || !pullRequest || !baseSha || !headSha) {
    throw new Error("Complete repository, PR, base SHA, and head SHA are required for a snapshot cache key.");
  }
  return `pr:${repository}:${pullRequest}:${baseSha}:${headSha}`;
}

async function resolveRemotePullRequestRefs(
  repository: RepositoryConfig,
  prNumber: number,
): Promise<{ baseSha: string; headSha: string }> {
  const baseRemoteRef = `refs/heads/${repository.baseBranch}`;
  const headRemoteRef = `refs/pull/${prNumber}/head`;
  const result = await git(repository, [
    "ls-remote",
    "--refs",
    repository.remoteUrl,
    baseRemoteRef,
    headRemoteRef,
  ], { timeoutMs: 30_000 });
  const refs = parseLsRemote(result.stdout);
  const baseSha = refs.get(baseRemoteRef);
  const headSha = refs.get(headRemoteRef);
  if (!baseSha || !headSha) throw new Error("GitHub did not return both base and PR head refs.");
  return { baseSha, headSha };
}

async function cachedSnapshotObjectsExist(repository: RepositoryConfig, snapshot: PullRequestSnapshot): Promise<boolean> {
  try {
    await Promise.all([
      git(repository, ["cat-file", "-e", `${snapshot.baseSha}^{commit}`]),
      git(repository, ["cat-file", "-e", `${snapshot.headSha}^{commit}`]),
    ]);
    return true;
  } catch {
    return false;
  }
}

function withSnapshotCacheMetadata(snapshot: PullRequestSnapshot, {
  hit,
  key,
  createdAt,
  now,
  validatedByRemoteRefs,
  validation,
  maxStalenessMs,
}: SnapshotCacheMetadataOptions) {
  return {
    ...snapshot,
    cache: {
      hit,
      key,
      ageMs: Math.max(0, now - createdAt),
      ttlMs: PR_SNAPSHOT_TTL_MS,
      validatedByRemoteRefs,
      validation,
      ...maxStalenessMs ? { maxStalenessMs } : {},
    },
  };
}

/** Fetches and normalizes one PR into the redacted snapshot used by all engines. */
export async function preparePullRequest(prUrl: string, {
  snapshotCache,
  now = Date.now(),
}: {
  readonly snapshotCache?: SnapshotStore<SnapshotCacheEntry>;
  readonly now?: number;
} = {}) {
  // Phase 1: canonicalize the allowlisted PR and derive isolated refs. Nothing
  // here changes the checked-out branch or working tree.
  const { repository, number: prNumber } = parsePullRequest(prUrl);
  const baseRef = `refs/friday/base/${repository.baseBranch}`;
  const headRef = `refs/friday/pull/${prNumber}/head`;
  const hotKey = `pr-hot:${repository.slug}:${prNumber}`;
  // Phase 2: a very short hot cache avoids repeated network calls during one
  // interactive retry. Its bounded staleness is disclosed in the result.
  try {
    const hot = await snapshotCache?.lookup(hotKey);
    if (hot?.snapshot && hot?.exactKey && await cachedSnapshotObjectsExist(repository, hot.snapshot)) {
      return withSnapshotCacheMetadata(hot.snapshot, {
        hit: true,
        key: hot.exactKey,
        createdAt: hot.createdAt,
        now,
        validatedByRemoteRefs: false,
        validation: "hot-ttl",
        maxStalenessMs: PR_HOT_CACHE_TTL_MS,
      });
    }
  } catch {
    // Cache failure must never block the controlled Git path.
  }
  // Phase 3: after the hot window, validate both remote SHAs before accepting a
  // cached snapshot. The exact key changes whenever base or PR head changes.
  let remoteSnapshot: { baseSha: string; headSha: string; key: string } | undefined;
  try {
    const remoteRefs = await resolveRemotePullRequestRefs(repository, prNumber);
    const key = buildPullRequestSnapshotCacheKey({
      repository: repository.slug,
      pullRequest: prNumber,
      ...remoteRefs,
    });
    const cached = await snapshotCache?.lookup(key);
    if (cached?.snapshot && await cachedSnapshotObjectsExist(repository, cached.snapshot)) {
      await snapshotCache?.register(
        hotKey,
        { createdAt: now, exactKey: key, snapshot: cached.snapshot },
        { ttlMs: PR_HOT_CACHE_TTL_MS },
      );
      return withSnapshotCacheMetadata(cached.snapshot, {
        hit: true,
        key,
        createdAt: cached.createdAt,
        now,
        validatedByRemoteRefs: true,
        validation: "remote-sha",
      });
    }
    remoteSnapshot = { ...remoteRefs, key };
  } catch {
    // Preserve the original controlled-fetch path when the lightweight ref
    // check or cache is unavailable. The fetch below remains authoritative.
  }

  // Phase 4: cache miss/failure falls back to the authoritative controlled
  // fetch into refs/friday/*; tags and submodules are deliberately excluded.
  await withRepositoryLock(repository, () => git(repository, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      repository.remoteUrl,
      `+refs/heads/${repository.baseBranch}:${baseRef}`,
      `+refs/pull/${prNumber}/head:${headRef}`,
    ], { timeoutMs: 60_000 }));

  // Phase 5: collect independent Git evidence in parallel. GitHub context uses
  // the fixed GET-only broker and safely degrades to Git-only metadata.
  const [mergeBase, baseSha, headSha, nameStatus, commits, diff, pullRequestContext] = await Promise.all([
    git(repository, ["merge-base", baseRef, headRef]),
    git(repository, ["rev-parse", baseRef]),
    git(repository, ["rev-parse", headRef]),
    git(repository, ["diff", "--name-status", "--find-renames", `${baseRef}...${headRef}`]),
    git(repository, ["log", "--format=%h %s", "--max-count=20", `${baseRef}..${headRef}`]),
    git(repository, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--unified=60",
      `${baseRef}...${headRef}`,
      "--",
      ":(glob)**/*.tf",
      ":(glob)**/*.tfvars",
      ":(glob)**/*.hcl",
      ":(glob)**/*.tf.json",
      ":(glob)**/*.json",
      ":(glob)**/*.yaml",
      ":(glob)**/*.yml",
      ":(glob)**/*.tpl",
      ":(glob)**/*.gotmpl",
      ":(glob)**/*.md",
    ]),
    fetchPullRequestExternalContext(repository, prNumber),
  ]);

  // Phase 6: redact and cap untrusted evidence before constructing the shared
  // snapshot consumed by review engines and the model.
  const capped = capText(redact(diff.stdout), MAX_DIFF_BYTES);
  const snapshot: PullRequestSnapshot = {
    repository: repository.slug,
    pullRequest: prNumber,
    baseBranch: repository.baseBranch,
    mergeBase: mergeBase.stdout.trim(),
    baseSha: baseSha.stdout.trim(),
    headSha: headSha.stdout.trim(),
    changedFiles: parseChangedFiles(nameStatus.stdout),
    commits: redact(commits.stdout).trim().split("\n").filter(Boolean),
    pullRequestContext,
    terraformDiff: capped.text,
    diffTruncated: capped.truncated || diff.truncated,
    safety: {
      workingTreeChanged: false,
      pushedRemoteChanges: false,
      fetchedInto: [baseRef, headRef],
      secretsRedacted: true,
    },
  };
  const key = buildPullRequestSnapshotCacheKey({
    repository: repository.slug,
    pullRequest: prNumber,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
  });
  // Phase 7: persist only when the earlier remote-SHA observation still matches
  // the fetched result; otherwise return the snapshot without claiming a
  // remotely validated cache entry.
  const cacheValidated = remoteSnapshot?.key === key;
  if (cacheValidated) {
    await snapshotCache?.register(
      key,
      { createdAt: now, snapshot },
      { ttlMs: PR_SNAPSHOT_TTL_MS },
    );
    await snapshotCache?.register(
      hotKey,
      { createdAt: now, exactKey: key, snapshot },
      { ttlMs: PR_HOT_CACHE_TTL_MS },
    );
  }
  return withSnapshotCacheMetadata(snapshot, {
    hit: false,
    key,
    createdAt: now,
    now,
    validatedByRemoteRefs: cacheValidated,
    validation: cacheValidated ? "remote-sha" : "fetch-only",
  });
}

/** Reads one safe file from an isolated base/PR ref without touching the worktree. */
export async function readRepositoryFile({
  repository: repositorySlug,
  path,
  source,
  prNumber,
}: GitReadFileParams): Promise<{
  repository: FridayRepositorySlug;
  source: "base" | "pr";
  ref: string;
  path: string;
  content: string;
  truncated: boolean;
  secretsRedacted: true;
}> {
  // Phase 1: validate both repository and relative path before building a Git
  // object expression, blocking traversal and sensitive file classes.
  const repository = resolveRepository(repositorySlug);
  const safePath = validateRelativePath(path);
  let ref;
  if (source === "base") {
    ref = `refs/friday/base/${repository.baseBranch}`;
  } else if (source === "pr") {
    const number = Number(prNumber);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("A valid prNumber is required for source=pr.");
    ref = `refs/friday/pull/${number}/head`;
  } else {
    throw new Error("source must be base or pr.");
  }

  // Phase 2: read directly from the isolated ref, then redact/cap before the
  // content crosses the adapter boundary.
  const result = await git(repository, ["show", `${ref}:${safePath}`], { timeoutMs: 15_000 });
  const capped = capText(redact(result.stdout), MAX_FILE_BYTES);
  return {
    repository: repository.slug,
    source,
    ref,
    path: safePath,
    content: capped.text,
    truncated: capped.truncated || result.truncated,
    secretsRedacted: true,
  };
}

/**
 * Reads a small redacted line window from the exact immutable PR head. This is
 * deliberately not an OpenClaw tool: only Unified Review may call it after a
 * finding is tied to a changed, allowlisted file.
 */
export async function readPullRequestFileContext(
  snapshot: Pick<PullRequestSnapshot, "repository" | "headSha" | "changedFiles">,
  file: string,
  line: number,
): Promise<PullRequestFileContext | undefined> {
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  const safePath = validateRelativePath(file);
  const changed = snapshot.changedFiles.some((item) => item.path === safePath && !item.status.startsWith("D"));
  if (!changed) return undefined;
  const repository = resolveRepository(snapshot.repository);
  const result = await git(repository, ["show", `${snapshot.headSha}:${safePath}`], { timeoutMs: 15_000 });
  if (result.truncated) return undefined;
  const allLines = redact(result.stdout).split("\n");
  if (line > allLines.length) return undefined;
  const contextRadius = 5;
  const snippetLines = 8;
  const startLine = Math.max(1, line - Math.floor(snippetLines / 2) - contextRadius);
  const endLine = Math.min(allLines.length, line + Math.ceil(snippetLines / 2) + contextRadius - 1);
  return {
    file: safePath,
    startLine,
    lines: allLines.slice(startLine - 1, endLine),
    secretsRedacted: true,
  };
}
