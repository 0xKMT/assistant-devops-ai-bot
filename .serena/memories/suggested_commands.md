# Suggested Commands

- Install reproducibly: `npm ci`.
- Full validation: `npm test` (alias of root `npm run check`).
- Root check sequence: portability audit, architecture audit, Node tests in `compat/slack/test/*.test.mjs` and `scripts/test/*.test.mjs`, then every workspace `check`.
- Typecheck all workspaces: `npm run typecheck`.
- Build all packages: `npm run build`.
- Run one workspace test suite: `npm --workspace @friday/git-adapter test` (substitute `@friday/security-shield`, `@friday/jira-adapter`, or `@friday/slack-recovery`); shared has typecheck/check but no test script.
- Run JavaScript setup/audit tests directly when isolating failures: `node --test compat/slack/test/*.test.mjs scripts/test/*.test.mjs`.
- Setup checks: `npm run setup:preflight`, `npm run audit:portability`, `npm run audit:architecture`.
- Container lifecycle: `npm run container:init`, `npm run container:setup -- --backend codex`, `npm run container:health`; use `--backend claude-code` for Claude Code.
- Native setup: `npm run setup:full`; compatibility dry-run/apply: `npm run setup:slack-compat` / `npm run setup:slack-compat:apply`.
- macOS-specific watchdog is packaged by the slack-recovery workspace; launchd template is `templates/launchd/ai.friday.slack-watchdog.plist.template`.
- Portability audit rejects macOS metadata. Remove untracked `.DS_Store` files before `npm test`.
- Do not use runtime-mutating setup/deploy commands merely to validate source changes.