# Project Core

- Friday is a private npm-workspaces monorepo for a local-first DevOps AI assistant.
- Source map:
  - `core/shared`: host-neutral schemas, types, and tool-result contracts; no integration/runtime dependency.
  - `core/security-shield`: OpenClaw authorization/persona/security-audit plugin.
  - `integrations/git-adapter`: bounded read-only PR review and Terraform/GitOps validation.
  - `integrations/jira-adapter`: requester-approved Slack-to-Jira draft workflow; creation only through deterministic approval callback.
  - `integrations/slack-recovery`: optional macOS launchd watchdog.
  - `scripts/`: setup, audit, compatibility, container orchestration; setup scripts coordinate packages and do not own domain logic.
  - `config/`: runtime examples/config contract; `container/`: deployment scripts; `compat/`: pinned Slack compatibility patches; `types/`: external SDK declarations.
- Entrypoints: each plugin `index.ts`; watchdog `integrations/slack-recovery/friday-slack-watchdog.ts`; setup `scripts/full-setup.mjs` and `scripts/container-bootstrap.mjs`; container runtime `container/entrypoint.sh`.
- Workspace dependency rule: packages use scoped workspace imports (for example `@friday/shared`), never cross-workspace relative imports; integrations do not call each other directly.
- Security invariant: model-visible operations remain schema-bound and allowlisted; no generic shell/filesystem-write/GitHub-write/deploy/cluster-mutation capability.
- Read architecture and package-specific docs for detailed boundaries: `docs/ARCHITECTURE.md`, `core/README.md`, `integrations/README.md`.
- For stack/build details read `mem:tech_stack`; for commands read `mem:suggested_commands`; for source style read `mem:conventions`; for completion gates read `mem:task_completion`.