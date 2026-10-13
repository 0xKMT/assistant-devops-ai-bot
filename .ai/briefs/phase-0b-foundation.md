# Orca brief: Phase 0B Foundation

Plan: `docs/PHASE_0B_FOUNDATION_PLAN.md`. Do not start a slice until the owner
has approved the plan PR.

## Run

- One Orca worktree per slice, in this order: A → B → D → C.
- Branches: `0xKMT/phase-0b-a-review-hygiene`, `0xKMT/phase-0b-b-shield-hardening`,
  `0xKMT/phase-0b-d-openclaw-spike`, `0xKMT/phase-0b-c-portability`.
- Base every branch on `main` after the plan PR merges.
- Git identity for every commit and push: user `0xKMT` with the 0xKMT GitHub
  noreply address already used in this repository's history
  (`git log --format='%ae' -1 main`).

## Roles per slice

1. **Researcher (read-only):** read AGENTS.md, SYSTEM_DESIGN, ROADMAP, the plan,
   and the Serena memories. Run GitNexus `impact` on every symbol the slice
   edits. Write findings to `.ai/notes/<slice>.md`. Stop and report to the owner
   on `HIGH` or `CRITICAL` risk.
2. **Builder:** implement only that slice's tasks, test first. No new
   model-facing tool, shell, write or network capability.
3. **Verifier:** run the slice's workspace check, then `npm test`,
   `npm run typecheck`, `npm run build`, `git diff --check`,
   `git status --short`, `git status --ignored --short`. Report Docker-dependent
   skips explicitly.
4. **Codex adversarial review:** focus on authorization, redaction, fail-closed
   defaults and idempotency. Fix or document every finding.

## Stop and ask the owner when

- A task would change a boundary not named in the plan.
- An item is Deferred or Prohibited in SYSTEM_DESIGN.
- Impact analysis is HIGH or CRITICAL (expected for Slice B).
- A test needs a real credential, a running gateway or a Docker daemon you do
  not have.

## Done means

PR opened from the slice branch by 0xKMT with: changed files, validation
results including skips, GitNexus `detect_changes` summary, and remaining
human gates. The owner merges.
