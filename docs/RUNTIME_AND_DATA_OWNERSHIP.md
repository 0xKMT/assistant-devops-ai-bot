# Friday Runtime and Data Ownership

This document records the Phase 0 ownership boundaries visible in the current
repository. It does not claim deployment health or introduce a new runtime,
database, or model-facing capability.

## State labels

- **Current:** implemented in repository source at the inspected commit.
- **Validated:** checked in this worktree with a named command.
- **Target:** approved architecture that is not implemented in Phase 0.
- **Runtime-proven:** observed during a real configured Friday execution.
- **Not runtime-proven:** supported by source or tests but not observed in a
  live Friday execution during Phase 0.

## Runtime ownership

| Owner | Current responsibility | Repository evidence | Evidence state |
| --- | --- | --- | --- |
| OpenClaw Gateway | Owns Slack ingress, model-turn orchestration, lifecycle dispatch, plugin registration, and resolution of the runtime state directory. Friday supplies bounded plugins rather than a parallel gateway. | `docs/ARCHITECTURE.md`; `scripts/container-bootstrap.mjs`; `container/entrypoint.sh` | Current; source-validated; Not runtime-proven |
| Security Shield | Authorizes the Slack principal before inference and again before tool work, binds authorization to one run, redacts outbound content, and owns its audit lifecycle. | `core/security-shield/index.ts`; `core/security-shield/core.ts` | Current; tests validated by `npm test`; Not runtime-proven |
| Git Adapter | Owns allowlisted read-only repository acquisition, bounded review tools, validator execution, and its disposable snapshot cache. | `integrations/git-adapter/index.ts`; `integrations/git-adapter/core.ts`; `integrations/git-adapter/runtime-config.ts` | Current; tests validated by `npm test`; Not runtime-proven |
| Jira Adapter | Owns bounded draft preparation and requester-bound interactive callbacks. Jira creation remains a deterministic approval callback and is not a model tool. | `integrations/jira-adapter/index.ts`; `integrations/jira-adapter/ticket-engine.ts`; `docs/ARCHITECTURE.md` | Current; tests validated by `npm test`; Not runtime-proven |
| Slack Recovery | Optionally observes and restarts the local macOS OpenClaw gateway after bounded failure conditions. It adds no Slack token, API, or infrastructure authority. | `integrations/slack-recovery/friday-slack-watchdog.ts`; `integrations/slack-recovery/README.md` | Current and optional; tests validated by `npm test`; Not runtime-proven |

Security Shield remains authoritative for identity and authorization. None of
the storage owners below can grant permission or bypass read-only and
requester-approval boundaries.

## Database ownership

All three current SQLite databases use WAL mode and are opened beneath the
directory returned by `api.runtime.state.resolveStateDir()`. They remain
separate because their retention, recovery, and correctness meanings differ.

| Store | Owner and current contents | Lifecycle and recovery | Repository evidence | Evidence state |
| --- | --- | --- | --- | --- |
| `friday-security.sqlite` | Security Shield stores bounded decision/reason data, HMAC-hashed account/workspace/sender/channel/session identifiers, and a database-local salt. It does not store message content or model output. | Opened for the gateway lifetime, pruned by bounded retention, and closed on `gateway_stop`. Preserve it when audit continuity matters; never expose its raw contents to the model. | `core/security-shield/index.ts`; `core/security-shield/audit-store.ts` | Current; source and unit-test validated; Not runtime-proven |
| `friday-cache.sqlite` | Git Adapter stores namespaced, bounded, expiring, redacted PR snapshot cache entries. The cache is an optimization; review code falls back to its controlled fetch path when cache access is unavailable. | Opened at plugin registration and closed on `gateway_stop`. It can be rebuilt from authoritative sources and must not be treated as workflow state. | `integrations/git-adapter/index.ts`; `integrations/git-adapter/sqlite-store.ts` | Current; source and unit-test validated; Not runtime-proven |
| `friday-jira.sqlite` | Jira Adapter stores structured requester-bound drafts, versioning, approval state, idempotency keys, create reconciliation, and link-delivery state. It does not store raw Slack transcripts. | Opened when the Jira plugin initializes and closed on `gateway_stop`. Preserve it across rollback so duplicate approvals, ambiguous creates, restarts, and link retries reconcile safely. | `integrations/jira-adapter/index.ts`; `integrations/jira-adapter/draft-store.ts`; `docs/ROLLBACK.md` | Current; source and integration-test validated; Not runtime-proven |
| `friday-learning.sqlite` | Would own learning jobs, knowledge candidates, feedback, and evaluation metadata under the approved architecture. | **Target, not current.** No Phase 0 source, migration, runtime registration, or database file implements this store. | `docs/LOCAL_DEVOPS_ASSISTANT_DESIGN.md` Sections 6 and 12 | Target; not validated; not runtime-proven |

## Filesystem ownership

| Location or state | Owner | Boundary | Repository evidence |
| --- | --- | --- | --- |
| OpenClaw state directory | OpenClaw Gateway | Resolves plugin databases through `api.runtime.state.resolveStateDir()`; it is distinct from the workspace and validator cache. | `config/README.md`; plugin entrypoints |
| `paths.cacheDir` / `cacheDir` | Git Adapter and local validators | Owns isolated Git mirrors plus Trivy and kubeconform caches. It is operational cache data, not OpenClaw workflow state. | `config/instance.example.json`; `scripts/prepare-instance.mjs`; `integrations/git-adapter/core.ts`; review engines |
| `friday-slack-watchdog.json` | Slack Recovery | Optional local macOS watchdog counters and recovery state, normally below OpenClaw state. It is not an application database and is never model-facing. | `integrations/slack-recovery/friday-slack-watchdog.ts`; `integrations/slack-recovery/README.md` |
| Generated `build/` and package `dist/` directories | Setup/build tooling | Reproducible artifacts only; not authoritative runtime state and not committed. | `.gitignore`; `docs/ARCHITECTURE.md` |
| `.gitnexus/` | Developer tooling | Local generated graph/index state. It is ignored by Git, excluded from Docker context, and trusted only when its path and commit match the active checkout. | `.gitignore`; `.dockerignore`; `scripts/lib/portability-audit.mjs` |

## Recovery boundaries

- Restoring OpenClaw configuration does not replace or merge the three Friday
  databases. Each owner keeps its own lifecycle.
- Preserve `friday-jira.sqlite` through application rollback unless an operator
  has separately reconciled all pending and ambiguous Jira/link outcomes.
- `friday-cache.sqlite` is disposable cache state; deleting it must not broaden
  repository access or change review policy.
- Retain or archive `friday-security.sqlite` according to the configured audit
  retention and local security policy. Do not copy raw rows into telemetry or
  learning data.
- Removing `friday-slack-watchdog.json` resets only optional watchdog history;
  it does not repair OpenClaw, authorize a requester, or recover Jira state.
- No recovery operation may weaken Security Shield, expose secrets, or turn a
  read-only/model-safe interface into a mutation interface.

## Evidence limits

Validated in the Phase 0 worktree:

```bash
npm test
npm run audit:portability
```

These commands validate source contracts, tests, builds, and repository hygiene.
They do not prove that a deployed gateway is healthy, that Slack is connected,
that a model provider returned usage, or that any current database exists on a
particular host. No configured Friday request was executed for this document,
so every live runtime behavior above remains Not runtime-proven.
