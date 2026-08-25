# Friday Git Adapter

Local OpenClaw tool plugin for bounded review of pull requests from explicitly
allowlisted local repositories.

The repository allowlist, local clone roots, base branches, binary locations and
cache directory are deployment configuration. The review core contains no
personal paths, organization names or fixed repository list. See
`config.example.json` for the portable contract.

Startup is fail-closed: every execution path must be absolute, every repository
must be unique, and remotes must use HTTPS GitHub URLs. Invalid or incomplete
configuration prevents the plugin from registering tools.

## Security boundary

- Uses existing local Git/GitHub credentials only through bounded operations.
- Accepts only allowlisted PR URLs.
- Fetches only the configured base branch (`develop` or `main`) and the requested PR head into `refs/friday/*`.
- Never checks out, resets, commits, pushes, or edits the working tree.
- Does not recurse into submodules.
- Returns Terraform/HCL, YAML, JSON, Helm-template, and Markdown diff content with credential redaction and size limits.
- Blocks `.git`, `.terraform`, state, environment, credential and key files.
- Registers both tools as optional so OpenClaw must explicitly allow them.

## Tools

- `friday_git_pr_context`
- `friday_git_read_file`
- `friday_terraform_review`
- `friday_gitops_review`
- `friday_unified_pr_review`
- `friday_batch_pr_review`

The first tool performs the controlled fetch. The second reads one allowlisted
file from a ref created by the first tool.

The Terraform review tool materializes the already-fetched PR head SHA into a
private temporary Git repository and runs Review Engine v1.1: Friday's
deterministic secret policy, TFLint, and Trivy misconfiguration/secret scans in
parallel. It attributes findings to changed and added PR lines, deduplicates
overlap, omits secret values and code excerpts, and returns a fail-closed gate.
It does not run `terraform init`, `plan`, `apply`, scanner updates, custom
commands, or fixes.

## PR snapshot cache

Before a full fetch/diff, the adapter performs a read-only `git ls-remote` for
both the configured base branch and PR head. A cached redacted snapshot is used
only when both SHAs match. Entries expire after 30 minutes and are stored in
Friday's dedicated local SQLite cache. Review Engine v1.1 uses a new cache
namespace so snapshots produced before structural secret redaction are never
reused.

For immediate retries, a 60-second hot entry skips the remote SHA check and
reports `validation: hot-ttl` plus its maximum staleness. After that short
window, both remote SHAs are checked again.

## Unified PR Review Engine v3

`friday_unified_pr_review` is the primary entrypoint across all repositories in
the deployment allowlist.
It prioritizes the PR title/body, then uses commits, comments, reviews, changed
files and diff keys to build the objective and acceptance criteria. If the local
GitHub metadata is read through OAuth Read Broker v1: the broker constructs only
fixed `GET` requests for the configured repository allowlist and never accepts an
arbitrary endpoint, method, header, body, or CLI argument from the model. If the
local GitHub CLI credential is unavailable, it fails safely to Git-only context
and reports that limitation rather than inventing a target.

The broker does not make the underlying OAuth `repo` scope cryptographically
read-only. It is a local application-policy boundary: Friday has no generic
GitHub CLI or shell tool, all non-GET operations are absent, output is capped and
redacted, and the OAuth token remains in the system credential store rather than
being returned to the plugin or model.

Terraform files are routed through policy, TFLint and Trivy. Helm, YAML, JSON,
Kustomize and Kubernetes changes are routed through the configuration review
path. Base/head lint and render comparison separates regressions from baseline
failures. Changed top-level values are traced to chart templates or declared
dependencies, and HPA invariants are checked deterministically.

Datadog Service Catalog files (`entity.datadog.yaml` and `*.datadog.yaml`) use
an additional offline v3 policy. It validates the schema-required identity
fields, rejects active template placeholders, checks catalog ownership and
environment tags, and deliberately keeps these entities out of Kubernetes
schema validation. Optional owner/environment quality rules remain warnings;
schema errors and active placeholders are blockers when introduced by the PR.

The unified result includes the PR objective, commit/change summary, applicable
coverage, per-engine evidence and one combined fail-safe gate. Findings are
returned in target, cross-cutting, and baseline buckets. Only target
Critical/High findings and new cross-cutting security findings block; incomplete
required coverage or low-confidence intent requires human review. Kustomize uses
root-only load restrictions, kubeconform validates rendered manifests, Trivy runs
offline, secret values are omitted, and no cluster or apply capability exists.

Human-Friendly Review Output v1 has one full-review contract: `review`, `review
nhanh`, and `review chi tiết` are request aliases, not different validation
modes. It turns structured evidence into a concise Slack review: an explicit
merge decision first, a plain-language objective, material validation results,
concrete impact/evidence/action bullets, and a separate capped section for
pre-existing baseline issues. Non-PASS replies may include at most two safe,
eight-line snippets immediately after their actions: added diff lines are
preferred, otherwise a bounded redacted changed-file context at the immutable PR
head may be used. It never lets baseline noise silently change the PR verdict or
claims a safe merge when the gate requires human confirmation.

## Batch PR Review v1

`friday_batch_pr_review` accepts two to five unique allowlisted PR URLs. It runs
Unified PR Review Engine v3 with a maximum concurrency of two, preserves input
order, isolates per-PR failures, and returns every requested PR exactly once in
a bounded aggregate. One failed fetch or validator path marks the batch partial
without discarding successful reviews. All single-PR read-only and redaction
guarantees remain in force.
