/**
 * Fail-closed runtime configuration for repositories, scanner binaries and
 * process isolation. Configuration is parsed once before tools are registered.
 */
import path from "node:path";

export interface RepositoryConfig {
  readonly slug: string;
  readonly root: string;
  readonly remoteUrl: string;
  readonly baseBranch: string;
}

export interface ReviewRuntimeConfig {
  readonly repositories: ReadonlyMap<string, RepositoryConfig>;
  readonly binaries: {
    readonly git: string;
    readonly gh: string;
    readonly ssh: string;
    readonly tflint: string;
    readonly trivy: string;
    readonly helm: string;
    readonly kustomize: string;
    readonly kubeconform: string;
  };
  readonly storage: {
    readonly cacheDir: string;
  };
  readonly process: {
    readonly home: string;
    readonly path: string;
  };
}

type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function absolute(value: unknown, label: string): string {
  const result = string(value, label);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be an absolute path.`);
  return path.normalize(result);
}

function repository(value: unknown, index: number): RepositoryConfig {
  const item = object(value, `repositories[${index}]`);
  const slug = string(item.slug, `repositories[${index}].slug`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new Error(`repositories[${index}].slug is invalid.`);
  const remoteUrl = string(item.remoteUrl, `repositories[${index}].remoteUrl`);
  const remote = new URL(remoteUrl);
  if (remote.protocol !== "https:" || remote.hostname.toLowerCase() !== "github.com") {
    throw new Error(`repositories[${index}].remoteUrl must be an HTTPS GitHub URL.`);
  }
  return Object.freeze({
    slug,
    root: absolute(item.root, `repositories[${index}].root`),
    remoteUrl,
    baseBranch: string(item.baseBranch, `repositories[${index}].baseBranch`),
  });
}

export function parseReviewRuntimeConfig(value: unknown): ReviewRuntimeConfig {
  const root = object(value, "Friday review config");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    throw new Error("Friday review config requires at least one repository.");
  }
  const repositories = root.repositories.map(repository);
  const registry = new Map<string, RepositoryConfig>();
  for (const item of repositories) {
    const key = item.slug.toLowerCase();
    if (registry.has(key)) throw new Error(`Duplicate repository slug: ${item.slug}.`);
    registry.set(key, item);
  }
  const binaries = object(root.binaries, "binaries");
  const storage = object(root.storage, "storage");
  const processConfig = object(root.process, "process");
  return Object.freeze({
    repositories: registry,
    binaries: Object.freeze({
      git: absolute(binaries.git, "binaries.git"),
      gh: absolute(binaries.gh, "binaries.gh"),
      ssh: absolute(binaries.ssh, "binaries.ssh"),
      tflint: absolute(binaries.tflint, "binaries.tflint"),
      trivy: absolute(binaries.trivy, "binaries.trivy"),
      helm: absolute(binaries.helm, "binaries.helm"),
      kustomize: absolute(binaries.kustomize, "binaries.kustomize"),
      kubeconform: absolute(binaries.kubeconform, "binaries.kubeconform"),
    }),
    storage: Object.freeze({ cacheDir: absolute(storage.cacheDir, "storage.cacheDir") }),
    process: Object.freeze({
      home: absolute(processConfig.home, "process.home"),
      path: string(processConfig.path, "process.path"),
    }),
  });
}

let activeConfig: ReviewRuntimeConfig | undefined;

/** Installs the validated immutable runtime used by subsequent review calls. */
export function configureReviewRuntime(value: unknown): ReviewRuntimeConfig {
  activeConfig = parseReviewRuntimeConfig(value);
  return activeConfig;
}

export function reviewRuntime(): ReviewRuntimeConfig {
  if (!activeConfig) throw new Error("Friday Portable Review Core is not configured.");
  return activeConfig;
}

export function resolveConfiguredRepository(slug: unknown): RepositoryConfig {
  const requested = String(slug ?? "").trim().toLowerCase();
  const result = reviewRuntime().repositories.get(requested);
  if (!result) throw new Error(`Repository ${slug || "(missing)"} is outside the Git adapter allowlist.`);
  return result;
}
