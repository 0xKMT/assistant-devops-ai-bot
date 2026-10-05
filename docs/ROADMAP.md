# Friday · Hermes · Factory Roadmap

Delivery order and gates, as of **2026-10-05**. Architecture and status meanings
come from [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md); repository authority comes from
[AGENTS.md](../AGENTS.md). Dates are planning windows, not authorization or proof
of completion. One phase per worktree/PR; Target implementation needs an approved
phase plan. A date never overrides an unmet gate.

## Progress at the documentation baseline

The owner’s overall plan reports work on `tripkm-everfit/phase-0-baseline-plan`
(17 commits ahead of main, work performed September 21–24). This worktree is
`tripkm-everfit/north-star-docs` at `743a686`, with 17 commits after the initial
commit in its visible history. The reported ahead-of-main/merge state is source
context, not a refreshed remote comparison.

| Item | Progress reported by the plan | Evidence in this worktree / status |
| --- | --- | --- |
| P0 | Done: baseline plan, GitNexus isolation, ownership record, compatibility spike | Current source/docs; spike Validated at declaration level; fresh graph identity not established here |
| P1 observability | Mostly done: isolated container trace pipeline, metadata-only Phoenix, synthetic golden eval | Current source/docs; full live trace/privacy exit gate remains Target |
| P1 WIP, uncommitted on phase-0 branch | openai-docs-adapter and OpenClaw trace-repair scripts | Target; absent here; do not describe as committed or validated on this branch |
| October 5 validation snapshot | Six workspace typecheck/build/test green; five Docker-dependent tests unavailable outside Mac | Historical report only; this checkout has five workspaces. Current command results belong in the change report |
| Phoenix metadata extension | Plan source does not distinguish all committed slices | Current: metadata-retention slice at 743a686; Target: trace probe, conditional patch, full gate and controlled cutover from the metadata plan |
| North-star instructions | This change introduces authoritative docs and phase-work skill | Target until this documentation change passes checks/review; no Factory hooks or runtime change |

Existing plans: [P0 baseline](PHASE_0_BASELINE_HYGIENE_PLAN.md),
[P1 observability](PHASE_1_CONTAINER_OBSERVABILITY_PLAN.md), and
[P1 metadata/trace continuity](PHASE_1_PHOENIX_METADATA_TRACE_PLAN.md).
Read the relevant design beside each plan. Presence of a plan does not prove that
all tasks or its operator gates are complete.

### Open review items: phase-0 branch openai-docs-adapter WIP

These are supplied review findings, not a fresh review of unavailable WIP.
They remain **Target repairs** and are not fixed in this documentation change:

1. **Medium:** successful tool output is not wrapped with `wrapUntrustedContent`;
   existing tests only prove the wrapper exists. Prove the returned content is
   actually wrapped.
2. **Low:** the URL gate accepts a non-default port and userinfo. Require
   `url.port === ""` and empty username/password, including redirect targets,
   and amend the Phase 1 plan before implementation.
3. **Low:** root `check` runs `scripts/test` before workspace builds. A clean
   checkout may fail on missing `dist/`; fix ordering in its own approved change.
4. **Low:** redaction lacks `xox`, `ghp_`, `github_pat_`, JWT and `AKIA` patterns.
   Add bounded coverage without placing real secrets in fixtures or docs.

## Phase windows: three coordinated lanes

The main delivery line spans approximately 17 weeks, **October 5, 2026 through
January 31, 2027**. P6e starts later. Parallel lanes coordinate dependencies;
each change still implements only one phase.

| Week / dates | Friday lane | Hermes lane | Factory lane | Status |
| --- | --- | --- | --- | --- |
| Before week 1 | P0 baseline done in source; merge/exit evidence to reconfirm | Not built | Existing Superpowers foundation | Current P0; remaining gates open |
| 1–2 / Oct 5–18, 2026 | Finish/merge P1, runtime proof; request Everfit P6 permissions | Preflight read-only mounts/per-bot toolset; isolated-machine proof | Dev Factory v1: Superpowers + Codex review + deny list | Current P1 source; Target completion/other lanes |
| 3–4 / Oct 19–Nov 1 | P2 memory: vault, memory-mcp, FTS5; per-source docs adapters | M1 personal: Codex OAuth, owner-only Telegram; Friday repo initially | Use Dev v1 for P2; two sessions/four roles; measure quota for two weeks | Target |
| 5–7 / Nov 2–22 | P3 approved learning: job outbox, review gate, lesson expiry | M2 researcher and M3 friday-learner; sourced inbox candidates | Infra Factory v1: one Terraform repo, evidence is plan | Target |
| 8–9 / Nov 23–Dec 6 | P6a AWS metadata reads and PR context | Weekly human candidate review and quality measurement | Infra Factory v2: Helm, Kustomize, CI; AutoHarness optional after evaluation | Target |
| 10–11 / Dec 7–20 | P6b pipeline/build/CodeDeploy/log templates | M4 AWS sandbox: EKS/Terraform labs and cleanup | Human-approved Friday brief → Factory input | Target |
| 12–14 / Dec 21, 2026–Jan 10, 2027 | P6c Datadog logs/monitors/traces/metrics | Operations: side projects/news, quota monitoring | Stabilize skills/hooks and three-step review; exact review composition needs plan | Target |
| 15–17 / Jan 11–31, 2027 | P6d Kubernetes reads; namespace allowlist, no Secrets | Operations | Operations | Target |
| 18+ / from Feb 1, 2027 | P6e alert classification only after stability gate | Operations | Operations | Target; Lunar New Year may affect schedule |

**Target sequencing:** request Everfit permissions in weeks 1–2, well ahead of
P6a. P3 depends on M3 and must be coordinated with M2–M3. M2/M3 labels follow the
plan’s ordering of researcher then learner; exact per-stage implementation needs
its approved plan. P6e is after the main January delivery line.

## Gates

These are the overall plan’s gate table translated into English. No new stage
starts until the previous applicable gate is met. Independent preflight and
human permission requests may proceed without implying product readiness.

| Stage | Gate to continue | Evidence state as of Oct 5 |
| --- | --- | --- |
| Weeks 1–2 / finish P0–P1, Hermes preflight, Dev v1 | P0–P1 branch merged; Docker-dependent tests green on Mac; P1 runtime proof through Slack; both OrbStack mount and Hermes per-bot checks have results | Open: source progress exists; merge, complete live proof and isolation gates not established by this change |
| Weeks 3–4 / P2, M1 | Friday can read approved but cannot modify it; personal bot stable for one week | Target, not met |
| Weeks 5–7 / P3, M2–M3, Infra v1 | No candidate self-activates; Infra Factory completes one real change | Target, not met |
| Weeks 8–9 / P6a, Infra v2 | Everfit approves role; IAM Access Analyzer reports no data-read permissions | Target, not met |
| Weeks 10–17 / P6b–P6d and operations | Each new tool has its own eval; Logs Insights cost and quota remain within agreed thresholds | Target, not met; numeric thresholds open |
| Weeks 18+ / P6e | Q&A stable for at least one month before automatic alert classification | Target, not met |

For P6e, complete stable P6a–P6d per the timeline, plus the one-month Q&A gate
and a reviewed Security Shield alert-source plan. The system design mentions
6a–6c stability; the later roadmap window also waits for 6d. Do not enable alert
input merely because it is read-only.

Stage gates cover the coordinated lanes; phase plans must add concrete
per-tool/per-bot acceptance, rollback and security checks without weakening them.
P0 compatibility declarations do not establish job-hook runtime behavior. P1
synthetic eval does not establish live model quality.

## Later

| Item | Revisit condition | Status |
| --- | --- | --- |
| P4 decision model / Clef | Separate suitable machine, proven deployment and measured benefit versus no-model baseline; no laptop hosting or new AI API key | Deferred |
| P5 cross-review | Claude Max budget and measured high-risk review benefit; approved routing/rollback plan | Deferred |
| Additional thread/plan/drift/cost/postmortem/ADR/on-call features | Approved phase plan and read-only/approval boundaries; phase allocation unresolved except Friday brief window above | Target, unscheduled |
| Vector DB, LangGraph, OPA, LiteLLM, second always-on machine | Conditions in SYSTEM_DESIGN decisions/operations; no permission expansion | Deferred |

## Assumptions and assignment

**Target planning assumptions:** 6–8 human hours/week, Claude Pro and ChatGPT Plus,
and Claude/Codex doing most implementation through Factory. The source estimates
80–90% of code by agents and roughly 3–5 heavy Factory sessions/week under Pro;
these are unmeasured estimates, not quota guarantees. More human time (10–15
hours/week) and Max might shorten work to 10–13 weeks, but employer permission
and elapsed stability gates still control P6. Measure before revising dates.

| Work | Claude / Codex | Human | Status |
| --- | --- | --- | --- |
| Plugins, tools, memory-mcp, Compose, tests, skills, hooks | Most implementation within approved phase plan | Brief, inspect diff | Target assignment |
| Code review | Subagent review and Codex adversarial review | Final approval, especially security | Target assignment |
| Docs, runbooks, setup guidance/scripts | Draft most content | Read/review | Target assignment |
| Design and phase scope | Propose options | Decide and approve plan | Target assignment |
| Every credential step: Telegram bot, Codex login in machine, Roles Anywhere CA/certificate, Datadog keys, Slack/Jira/Kubernetes tokens | Write guidance and bounded scripts; never enter/retain credential values | Personally provision/authenticate/run credential steps | Target, human-only |
| Everfit permission request | Draft request and sample policy; do not send without instruction | Request/obtain approval | Target, human-only |
| Live Slack tests / acceptance | Prepare checklist | Perform and record acceptance | Target, human-only |
| Real Everfit PR evaluation set | Format and score | Select PRs and correct answers with data permission | Target assignment |
| Weekly lesson approval | Generate candidate list; never activate | Approve, edit or reject every week | Target, human-only |

**Target operating rhythm:** small phase briefs that fit one Factory session;
human approves brief, agents execute, human reviews output. Bottlenecks are
quota, human review time, Everfit permissions and required running time.

## How to update this file

Whoever completes a phase or gate updates its status here **in the same change**,
with date, command/evidence reference, source versus runtime limits, and any
remaining gate. Update SYSTEM_DESIGN in the same change when architecture or a
boundary changes. Keep old snapshots clearly historical; never promote a Target
item from a build alone. Write new approved plans under `docs/PHASE_<n>_<TOPIC>_PLAN.md`,
not `docs/superpowers/`. Do not commit or push without a human request.
