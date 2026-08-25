# Task Completion

- Normal completion gate: run `npm test` from the repository root. It covers portability and architecture audits, root JS tests, workspace typechecks/tests/builds, and emitted-bundle syntax checks.
- Before claiming completion, also run `git status --short` and inspect `git status --ignored` for generated/runtime/secrets/macOS metadata.
- If `npm test` is blocked by portability metadata, remove the specific `.DS_Store`/OS artifact from the repository scope, then rerun; do not weaken the audit.
- For a focused change, at minimum run `npm --workspace <workspace-name> test` plus `npm run typecheck`; run `npm run build` when package entrypoints or exported code changed.
- There is no separate lint or formatter command in package scripts.
- Current verification evidence: `npm test` passed end-to-end after `.DS_Store` removal; portability and architecture audits passed, root tests passed (22), and workspace checks passed (security-shield 19, git-adapter 104, jira-adapter 93, slack-recovery 3; shared typecheck passed).