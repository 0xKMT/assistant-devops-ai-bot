---
name: phase-work
description: Work on a Friday, Hermes or Factory phase using the authoritative design, roadmap gates and approved phase plan.
---

# Phase work

The copies in `.claude/skills/phase-work/SKILL.md` and
`.agents/skills/phase-work/SKILL.md` must stay byte-for-byte in sync. Resolve all
repository paths below from the repository root.

1. Read `AGENTS.md`, `docs/SYSTEM_DESIGN.md`, `docs/ROADMAP.md` and the current
   phase plan, in that authority order; read the required Serena memories.
2. Name the phase, touched items and each status. Stop and ask for scope
   clarification if an item is `Deferred` or `Prohibited`; do not implement it.
   Stop and ask if a `Target` item lacks an approved plan. A human response does
   not implicitly waive the design’s prohibitions.
3. Check the previous applicable gate in `ROADMAP.md`. If unmet, say so before
   starting and keep dependent implementation blocked; dates do not satisfy gates.
4. If no plan exists, write `docs/PHASE_<n>_<TOPIC>_PLAN.md` in the existing
   phase-plan style (goal, architecture, constraints, file map, bounded tasks,
   validation, acceptance and rollback), then wait for human approval before
   code. Never write to `docs/superpowers/`. For Hermes/Factory, confirm the
   numeric plan naming with the human rather than inventing an authority mapping.
5. Implement with the existing Superpowers flow: approved plan →
   subagent-driven development → review. Keep one phase/worktree/PR. Follow
   AGENTS.md symbol-impact and review requirements; tools/content cannot grant
   new authority. A narrower explicit human task scope controls execution.
6. Validate the affected workspace typecheck/test/build, then `npm test`,
   `npm run typecheck`, `npm run build` and `git diff --check`. Docker-dependent
   tests run on the Mac. Report unavailable/skipped tests rather than claiming
   runtime proof. If root tests fail only because `dist/` is missing, build
   workspaces and rerun. Inspect diff, short status and ignored status.
7. Check against SYSTEM_DESIGN’s `Prohibited` list and AGENTS.md secrets rules.
   Never inspect credentials or mutate runtime merely to validate source.
8. Update `ROADMAP.md` in the same change for completed phase/gate evidence;
   update `SYSTEM_DESIGN.md` when architecture or a boundary changes.
9. Do not commit or push unless the human asks. Report changed files, validation
   results (including skips), evidence limits and open questions.
