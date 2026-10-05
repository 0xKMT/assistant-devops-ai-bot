# Friday · Hermes · Factory System Design

Authoritative target design, condensed from the owner’s system design and overall
plan dated 2026-10-05. The newer system design wins on source conflicts.
[AGENTS.md](../AGENTS.md) defines authority and repository rules;
[ROADMAP.md](ROADMAP.md) defines delivery order and gates. This document defines
what to build, not permission to deploy it.

## 1. Purpose, scope and constraints

**Target:** a personal, local-first DevOps assistant on a MacBook M5 with 16 GB
RAM and OrbStack. Friday reviews infrastructure PRs and drafts Jira tickets;
a separate personal agent handles sandbox work and knowledge candidates;
Factory develops software and infrastructure under human supervision.

**Target hard constraints:** subscriptions only (ChatGPT Plus for Codex and
Claude Pro for Claude Code), no additional AI API keys, no shared team service,
and configuration-enforced isolation through mounts, networks and credential
wiring. The source budget is approximately USD 40/month for two USD 20 plans;
these are planning assumptions, not verified current pricing or billing terms.
OrbStack personal licensing and employer-related use require human confirmation.

**Target deployment (owner decision, 2026-10-06):** only Friday and its
supporting services run in containers; Hermes runs in an OrbStack isolated
machine; Factory (Claude Code, Codex, Orca) and Obsidian run on macOS. The
earlier phrase “everything in containers” means Friday’s runtime services only;
there is no stricter all-container requirement.

**Prohibited:** autonomous production remediation, widening Friday to the team
under this personal design, and hosting Clef on this laptop.
**Deferred:** a decision model on separate suitable hardware, cross-review,
vector storage and additional orchestration complexity, under the conditions below.

## 2. Status vocabulary and current evidence

Use these labels for every component, feature and decision:

- **Current:** exists on this branch and is tested. It does not mean deployed.
- **Validated:** proven by a spike or runtime proof, not yet productized;
  identify the evidence and its limits.
- **Target:** agreed design, not built; requires an approved phase plan before code.
- **Deferred:** not for this delivery line; state a condition to revisit.
- **Prohibited:** must never be built or enabled within this design’s authority.

Runtime proof is a separate evidence field, not a replacement for these labels.
A build, declaration probe or synthetic eval cannot prove a live Slack turn.

**Current:** the detailed Friday baseline is maintained in
[ARCHITECTURE.md](ARCHITECTURE.md) and its
[current diagram](architecture/friday-current.mmd). The
[runtime/data ownership record](RUNTIME_AND_DATA_OWNERSHIP.md),
[model backends](MODEL_BACKENDS.md) and
[acceptance checklist](ACCEPTANCE.md) establish existing boundaries.
This checkout contains five npm workspaces, not the six reported for the
phase-0 branch’s WIP. Existing tests cover Security Shield, PR review, Jira,
recovery, observability configuration and synthetic evaluation.

**Validated:** the [OpenClaw compatibility spike](OPENCLAW_COMPATIBILITY_SPIKE.md)
proves pinned lifecycle declarations only. The container guide records prior
Compose/Collector/privacy and golden-fixture validation. **Target:** complete
Slack-to-tool-to-response trace continuity and privacy acceptance; no live
runtime proof is established by this documentation change.

## 3. Three systems

| System / feature | Responsibility and boundary | Status / phase |
| --- | --- | --- |
| Friday / OpenClaw | One Slack control plane; Security Shield authorizes before inference and tool work; bounded PR review for Terraform, Helm, Kubernetes, Kustomize and Datadog Service Catalog | Current / P0 baseline |
| Friday / Jira | English private requester-only draft; edit title, Task/Bug/Story, description, priority, existing Epic and numeric estimate; deterministic Approve & Create, then URL-only thread post; no model create tool | Current / baseline |
| Friday / observability | Opt-in private Collector/Phoenix and reproducible synthetic golden eval; metadata-only policy | Current / P1 source; live exit gate open |
| Friday / docs | Fixed documentation tool per source; OpenAI first, then AWS, Terraform, Kubernetes, Helm and Tyk | Target / P1–P2; OpenAI WIP only on phase-0 branch |
| Friday / approved knowledge | Cite approved runbooks, ADRs and incidents through bounded memory search/read | Target / P2 |
| Friday / learning | Structured redacted jobs, candidates and weekly human approval | Target / P3 |
| Friday / SRE | Read-only infrastructure context and incident diagnosis | Target / P6a–P6e |
| Friday / thread summaries, brief, plan/drift/cost explanation, postmortem/ADR/on-call drafts | Read evidence and propose; approved external writes only; no remediation | Target / future extension; exact phase except brief is open |
| Personal agent | One pinned Hermes in Bot Mode, profiles personal, friday-learner and optional researcher; Telegram owner-only, separate memory/skills/environment per profile | Target / M1–M4 |
| Factory | Claude Code + Codex through Orca; builds on existing Superpowers design → plan → subagent-driven implementation → review | Target / Dev v1 → Infra v1/v2 → operations |

**Target personal features:** code side projects and propose Friday PRs, sandbox
R&D, scheduled news/certificate reminders/cost reports, and AWS sandbox labs
including EKS/Terraform and cleanup. Destructive sandbox actions require human
confirmation. Hermes does not replace OpenClaw or the supervised host Factory.

**Target Factory roles:** two sessions: first discuss/research and write the
handoff, then execute in an Orca worktree. Researcher is read-only; change-brief
writes only `.ai/`; builder stays within one phase/package and does not deploy;
verifier runs checks. Codex provides adversarial review focused on authorization,
redaction and idempotency. The source calls this “four roles” while naming a
separate Codex reviewer; reviewer is a review step, not permission authority.
Human approves the brief before code and the diff/review before merge.

**Target tooling:** Orca is selected; `codex-plugin-cc` provides Codex review
integration (source names both `/codex:review` and `/codex:adversarial-review`;
verify the installed command). GitNexus/Serena support source navigation.
Factory hooks deny apply/deploy and secret reads, typecheck the affected workspace
after TypeScript edits, and report verified/unverified work on stop. These hooks,
shared MCP configuration and Dev Factory agents are future phase work, not
installed by this change. **Deferred:** OpenRig unless Orca is explicitly
reconsidered; Oh My Pi unless a measured local Ollama use case exists.

## 4. Deployment zones and file handoff

**Target:** zones never call each other over the network. Friday’s internal
services may communicate inside its zone; each zone has its own allowlisted
external connections. Knowledge crosses zones only through three folders:

| Shared folder | Writer | Reader | Status |
| --- | --- | --- | --- |
| `learning-jobs/` | Friday’s bounded redacted job producer | Hermes friday-learner, read-only | Target / P3 |
| `vault/inbox/` | friday-learner and researcher candidates | Human via Obsidian | Target / P2–P3 |
| `vault/approved/` | Human after approval, including edits/removal | memory-mcp, read-only; Friday through MCP | Target / P2 |

Personal repositories are a separate mount within Hermes, not another
cross-zone knowledge channel. Infrastructure clones remain Friday `/repos:ro`.
No Everfit credential directory is mounted into Hermes.

**Target Friday network:** one Compose project, internal `friday-net` for
memory-mcp/Collector/Phoenix, gateway-only internet egress; Phoenix UI loopback
`127.0.0.1:6006`. Retain read-only root, non-root user, `cap_drop: ALL`,
`no-new-privileges`, tmpfs and no Docker socket. The exact target network/resource
layout needs a phase plan; current overlay details remain in the container guide.

**Target Hermes:** `orb create --isolated --isolate-network`, pinned Hermes,
Codex device authentication by the human, Bot Mode profiles and systemd restart.
Mount only jobs (read-only), inbox (write), and personal repositories. Do not
copy the source’s mount command into deployment until read-only mount semantics
are proven. An isolated machine shares a kernel; it is not an absolute security
boundary against malicious code.

## 5. Components

| Component | Zone | Runs as | Responsibility | Interfaces | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- |
| friday-gateway | Friday | OpenClaw container | Current Shield, PR review and approved Jira; target job outbox | Slack Socket Mode, Jira, bounded GitHub reads, selected model backend | Baseline; jobs P3 | Current baseline; Target jobs |
| Documentation adapters | Friday | One plugin/workspace per source | Fixed official-document retrieval | Fixed host/path tool; OpenAI first | P1–P2 | Target |
| SRE adapters | Friday | Gateway plugins | Diagnose, never remediate | Bounded AWS, pipeline/log, Datadog, Kubernetes APIs | P6 | Target |
| memory-mcp | Friday | Node container + SQLite FTS5 | Index approved Markdown, memory.search/get | Internal MCP on friday-net | P2 | Target |
| otel-collector | Friday | Opt-in container | Default-deny metadata filter | Internal OTLP/HTTP | P1 | Current source; prior validation recorded |
| phoenix | Friday | Opt-in container | Private traces/eval store | Internal OTLP; loopback UI | P1 | Current source; live gate open |
| personal | Hermes | Bot Mode profile | Side projects, Friday PR proposals, sandbox labs | Owner-only Telegram | M1, M4 | Target |
| friday-learner | Hermes | Bot profile + cron | Jobs → candidates; weekly notification | Files; Telegram notification only | M3 / P3 | Target |
| researcher | Hermes | Optional bot profile + routine | Web sources → sourced candidates | Telegram, web | M2 | Target |
| Orca | Factory / host | macOS app | Worktrees, diff, quota | Human-supervised development | Dev v1 | Target workflow; worktree already used |
| Claude Code + Codex | Factory / host | Interactive CLIs | Four roles + independent review, hooks/deny list | Friday and infra repos | Dev/Infra Factory | Target workflow |
| Obsidian | Host | macOS app + separate Markdown Git vault | Human approval and knowledge rollback | inbox → approved | P2–P3 | Target |

## 6. Main flows

### PR review — Current; memory P2 and jobs P3 are Target

1. Owner mentions Friday with an allowlisted PR link.
2. Security Shield checks account, workspace, channel and user; unauthorized
   requests silently stop before inference/tools.
3. Bounded adapters read the diff and run TFLint, Trivy, Helm, Kustomize and
   kubeconform as appropriate; the model receives no generic shell.
4. Target P2: retrieve approved conventions through memory.search.
5. Reply in the Slack thread. Target P3: write a structured redacted job.

### Jira draft — Current

1. Owner mentions Friday in a thread; bounded eligible context produces a
   private English draft, with missing facts marked.
2. Only the requester edits or approves the bound draft/version.
3. Deterministic callback rechecks authorization and idempotency, creates the
   configured ED issue, and posts only its URL. Ambiguous creates reconcile
   before retry; retain durable Jira state.

### Learning — Target / P3

1. Friday writes job-id JSON: task type, outcome, redacted correction, finding
   IDs and evidence links; no raw PR/thread content.
2. Nightly friday-learner processes unseen job IDs idempotently with no
   terminal, web, delegation or communication with other bots.
3. Write inbox candidates with source job, confidence, scope and review date;
   reject secrets, missing provenance, duplicates and schema errors.
4. Notify the human weekly through Telegram.
5. Human edits, rejects or moves candidates to approved and commits the vault.
6. memory-mcp reindexes approved; subsequent Friday turns can cite it.

### Factory change — Target / Dev and Infra Factory

1. Human writes/approves a brief; a later Friday draft still requires approval.
2. Session 1 researches and writes the handoff.
3. Session 2 executes the approved plan in an Orca worktree with bounded roles.
4. Verify Friday with repository checks, or infra with plan/diff/validators.
5. Codex adversarial review, human-authorized PR creation, then Friday PR review.
6. Human approves diff/plan; authorized CI applies dev → staging → production.
   Agents never apply or deploy themselves.

### Personal work — Target / M1, M4

1. Owner sends a Telegram task to personal.
2. Operate only on personal repos/AWS sandbox, with isolated credentials.
3. Return results or a proposed PR; confirm destructive actions with the human.

### Internet knowledge — Target / M2, P3

1. Researcher reads an owner-supplied link or selected AWS/EKS, Terraform provider
   and Tyk changelog sources on a routine.
2. Candidate frontmatter requires source_url, retrieved_at, review_by and scope.
3. Reject missing-source candidates; human approves the remaining candidates.
4. At review_by, remind the human; expired lessons leave approved. The deletion
   owner/mechanism must be specified in P3, without automatic agent activation
   or writes to approved.
5. Friday’s fixed docs tools may cite official evidence directly; retrieval
   never automatically turns it into memory.

### Incident investigation — Target / P6

1. Owner asks about a pipeline failure or service error window.
2. Shield authorizes; memory.search retrieves approved runbooks/incidents.
3. Read narrow-to-wide: pipeline status, bounded error logs, Datadog and AWS
   configuration, at most 15 tool calls per question.
4. Respond with linked evidence, inference, uncertainty and proposed next steps.
5. Human remediates; Jira/postmortem drafts still need approval before creation.

## 7. Security boundaries and permissions

**Current decision:** Security Shield is the authorization authority; models,
reviewers and any future decision model can recommend refusal only. All PRs,
logs, threads, web content and knowledge remain untrusted evidence.

| Zone / profile | Permitted credential wiring | Read / write boundary | Status |
| --- | --- | --- | --- |
| Host Factory | Human GitHub, read-only dev AWS and Claude/Codex login | Opened repos; supervised worktrees/branches/PRs | Target Factory policy |
| friday-gateway | Local Slack/Jira, read-only GitHub and selected model auth; P6 certificate/Datadog/ServiceAccount secrets | Current repos read-only, private state; Target jobs and allowlisted SRE reads | Current baseline; Target P6 |
| memory-mcp | None | approved read-only; writable index only; no internet | Target |
| Collector / Phoenix | None | Sanitized telemetry; own data volume; no internet | Target placement; Current telemetry source |
| personal | Separate Telegram, fine-grained personal/Friday-repo GitHub access, AWS sandbox; never Everfit | Personal repos and sandbox only | Target |
| friday-learner | Scoped Codex auth only; notification wiring unresolved | Read jobs; write inbox only; model egress only | Target |
| researcher | Scoped Codex auth; notification wiring unresolved | Web; inbox writes only | Target |

Credential steps are human-only. “Agents do not hold credentials” means models
must never receive, enter or retain credential values; human-managed runtime
wiring is confined to its own zone. The source’s no-credential learner row and
Telegram notification requirement need a concrete, reviewed credential boundary.

### Prohibited

- Friday generic shell, arbitrary filesystem writes, arbitrary URL/path fetch,
  GitHub write, apply/deploy, cloud/cluster mutation, pipeline retry/rollback/restart.
- Direct reads of Terraform state; inspect redacted CI plan evidence instead.
- Reading secrets/data through broad AWS ReadOnlyAccess, static AWS access keys,
  general AWS MCP, Kubernetes Secrets, or mounts of company AWS/kube/SSH credentials
  into Hermes.
- Models holding credentials, secrets in prompts/traces/knowledge/jobs, raw runtime
  state or local paths in model-facing output.
- Any agent automatically activating lessons, skills or policy; approved knowledge
  changes remain human-only. Hermes-generated skills remain inactive candidates.
- friday-learner terminal/web/delegation, bot-to-bot messaging, or jobs stored in
  personal memory; cross-zone network calls or shared databases/memory.
- A second Friday control plane, direct Hermes Claude OAuth, team-wide Friday,
  new AI API keys, or Clef hosting on this laptop.

Existing repository [security rules](../AGENTS.md#security-and-scope) remain
binding. Jira’s deterministic human-approved callback is the bounded existing
write exception; no model-facing Jira create operation is introduced.

## 8. Documentation tools — Target / P1–P2

Follow the `openai-docs-adapter` pattern under development on the phase-0 branch;
it is absent from this checkout and is not treated as Current.

| Contract | Requirement | Status |
| --- | --- | --- |
| Inputs | No parameters or an allowlisted page enum; no model URL, path, header or query | Target |
| Sources | One fixed tool/workspace per source: fixed host and path prefix; OpenAI first, then AWS docs, Terraform Registry, Kubernetes, Helm, Tyk | Target |
| URL gate | HTTPS, exact host/prefix, url.port === "", empty username/password; recheck every redirect | Target |
| Redirects | Manual; at most 3, reject the fourth | Target |
| Bounds | 5-second timeout, streamed 128 KiB cap, text/markdown or text/plain only | Target |
| Success | Source URL, retrieval timestamp, content wrapped with wrapUntrustedContent as untrusted evidence | Target |
| Failure | Finite classified failure, HTTP code only in 400–599; no stale fallback | Target |
| Error diagnostics | Failure only; redacted tmpfs /tmp/friday-error-diagnostics, 16 KiB/record, 1 MiB total, 100 records, 24-hour retention; clear on gateway stop; never Phoenix | Target |

Copy the bounded adapter pattern and its tests for each new source. Docker does
not enforce domain-level egress; the code URL gate is the primary boundary.
Exact hosts/path prefixes and non-OpenAI content-type compatibility need phase
plans. Free web browsing belongs only to researcher.

## 9. Friday SRE — Target / P6

Read live context to strengthen PR review and incident diagnosis; no remediation.
Everfit must approve laptop-based access before any credentials are created.

| Stage | Capability | Dependency | Status |
| --- | --- | --- | --- |
| P6a | AWS metadata inventory/describe and PR context | Reviewed metadata-only role, cache | Target |
| P6b | CodePipeline, CodeBuild, CodeDeploy and CloudWatch logs | P6a | Target |
| P6c | Datadog logs, monitors, traces and metrics | Read-scoped API/application keys | Target |
| P6d | Kubernetes namespace-scoped reads, no Secrets | Reviewed ServiceAccount RBAC | Target |
| P6e | Automatic alert classification | Stable Q&A and accepted alert principal in Shield | Target |

The system source requires stable 6a–6c for 6e; the plan schedules 6e after
6a–6d and at least one month of stable Q&A. Use the later, stricter roadmap
gate; it does not authorize a new alert source before a phase plan.

| Tool | Source / permission | Bound | Status |
| --- | --- | --- | --- |
| aws_inventory_search | Resource Explorer; resource-explorer-2:Search | 50 results | Target |
| aws_config_query | Config SelectResourceConfig / SelectAggregateResourceConfig | Fixed SQL templates only | Target |
| aws_describe | Allowlisted service/operation pairs; specific Describe/List actions | 5-minute cache | Target |
| pipeline_status / pipeline_execution | CodePipeline Get/List | Allowlisted pipelines | Target |
| build_logs | CodeBuild BatchGetBuilds; Logs FilterLogEvents | 300 lines around error | Target |
| logs_query | Logs StartQuery / GetQueryResults | Templates, default one-hour window | Target |
| datadog_logs/monitors/traces/metrics | Read-scoped Datadog API | Time window, result and rate caps specified in plan | Target |
| k8s_inspect | Kubernetes get/list/watch excluding Secrets | Allowlisted namespaces | Target |

Redact and truncate every output before the model; cap all investigation at
15 calls. No raw aws/kubectl/shell tool. Plan artifacts replace state reads.

### IAM policy sample — Target, review required

This is the source’s starting sample, **not a deployable approved policy**.
Human review and IAM Access Analyzer must check data-bearing actions,
resource-level support, account/region/log-group restrictions and least privilege.
Do not substitute AWS managed ReadOnlyAccess. Even GetPipeline action configuration
requires redaction. DescribeInstanceAttribute/DescribeLaunchTemplateVersions can
expose user data; BatchGetProjects can expose environment values.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ViewMetadata",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*", "elasticloadbalancing:Describe*", "rds:Describe*",
        "eks:Describe*", "eks:List*", "route53:List*",
        "codepipeline:Get*", "codepipeline:List*",
        "codebuild:BatchGetBuilds", "codebuild:List*",
        "codedeploy:Get*", "codedeploy:List*", "codedeploy:BatchGet*",
        "resource-explorer-2:Search", "config:SelectResourceConfig",
        "config:SelectAggregateResourceConfig", "tag:GetResources",
        "cloudwatch:DescribeAlarms", "cloudwatch:GetMetricData"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadAllowedLogGroups",
      "Effect": "Allow",
      "Action": ["logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults"],
      "Resource": ["arn:aws:logs:*:*:log-group:/aws/codebuild/*"]
    },
    {
      "Sid": "DenyDataAccess",
      "Effect": "Deny",
      "Action": [
        "secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters",
        "ssm:GetParametersByPath", "kms:Decrypt", "s3:GetObject",
        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
        "lambda:GetFunction", "ec2:GetPasswordData",
        "ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions",
        "codebuild:BatchGetProjects", "rds:DownloadDBLogFilePortion"
      ],
      "Resource": "*"
    }
  ]
}
```

### Credentials — Target; human provisions every step

| System | Provisioning | Storage | Status |
| --- | --- | --- | --- |
| AWS | Roles Anywhere with human-managed CA/trust anchor; aws_signing_helper obtains and renews one-hour temporary credentials | Certificate/private key as Docker secrets; no static access key | Target |
| Multi-account AWS | friday-viewonly per approved account; allowlisted role assumptions only | Instance configuration references | Target |
| Datadog | API key plus application key scoped to reads for logs/monitors/APM/metrics | Docker secrets | Target |
| Kubernetes | friday-viewer ServiceAccount, reviewed get/list/watch RBAC excluding Secrets, short-lived token | Docker secret | Target |

**Target cost/risk controls:** narrow bounded Logs Insights windows and query caps
because scanned bytes incur cost; assess AWS Config configuration-item cost before
enabling; source assumes Resource Explorer is free, to be verified. Describe APIs
need caching/throttling control; Datadog has rate limits. Investigation consumes
more Codex quota than PR review. Logs may contain secrets, personal data or prompt
injection and remain bounded, redacted evidence. Numeric cost ceilings are open.

## 10. Storage, model roles, resources and operations

| Store | Owner / contents | Recovery | Status |
| --- | --- | --- | --- |
| friday-security.sqlite | Security Shield; hashed audit | Friday backup, retain audit continuity | Current |
| friday-cache.sqlite | Git Adapter; TTL snapshots | Disposable/rebuildable | Current |
| friday-jira.sqlite | Jira Adapter; drafts/idempotency/reconciliation | Friday backup; preserve during rollback | Current |
| learning-jobs JSON | Friday produces redacted jobs; learner consumes | No backup required by source; 30-day cleanup | Target / P3 |
| approved Markdown vault | Human-approved knowledge, provenance/promotion history | Separate Git; each approval committed | Target / P2–P3 |
| inbox Markdown vault | Hermes candidates, human review | Separate Git | Target / P3 |
| memory_index | memory-mcp FTS5 copy of approved | Rebuild from vault | Target / P2 |
| Hermes profile state | Per-bot memory, skills, environment and cron | Encrypted machine snapshots | Target / M1–M3 |
| Phoenix state | Sanitized traces/eval | Optional backup; retain on rollback | Current source |

No cross-zone database. Vault is knowledge authority; index is derived. Revert a
vault commit and reindex to remove an incorrect lesson. **Target open decision:**
phase plans must reconcile the older friday-learning.sqlite proposal with file
jobs and a separate FTS5 index; this document does not invent a new shared store.

| Role | Intended model / reasoning | Subscription | Status |
| --- | --- | --- | --- |
| Friday executor | GPT-6 Sol, medium | ChatGPT Plus | Target selection |
| Friday cross-review | Disabled under Claude Pro | Unassigned until upgrade/eval | Deferred / P5 |
| friday-learner / researcher | GPT-6 Luna | ChatGPT Plus | Target |
| personal | GPT-6 Sol | ChatGPT Plus | Target |
| Factory orchestrator / executor | Claude Opus, medium; one active session | Claude Pro | Target |
| Factory researcher | Sonnet or Haiku, read-only; at most 2–3 parallel | Claude Pro | Target |
| Factory high-risk adversarial review | GPT-6 Astra | ChatGPT Plus | Target |

These names are owner-selected target roles, not claims of model availability,
exact IDs, pricing or measured quota. **Current:** repo backend examples and
Collector allowlist use GPT-5.6 names; switching needs a reviewed phase plan,
verified catalog/auth and telemetry allowlist. Claude backend support remains
Current, while the Target runtime selects Codex; Claude is reserved for Factory.
Hermes direct Claude OAuth/Max extra-usage credits are not used.

**Target quota:** Friday, Hermes and Codex Factory reviews share ChatGPT allowance;
measure two weeks in Orca. The source proposes extra Codex credits or Claude Max
5x if limits recur; human decides after measurement, with no new AI API keys.
Claude CLI billing claims in the older plan are assumptions to confirm, not
reasons to enable Claude in Hermes or Friday.

| Resource | Source estimate / target cap | Status |
| --- | --- | --- |
| OrbStack total | 8 GB; idle overhead 0.5–1 GB | Target, measure |
| friday-gateway | 2 GB, 2 CPUs; idle 0.3–0.5 GB, peak 1.2–1.8 GB with Trivy | Target limits, measure |
| Hermes machine | Within OrbStack budget; idle 0.5–1 GB, peak 1.5–2.5 GB | Target estimate |
| memory-mcp | 256 MB; idle 0.1 GB, peak 0.2 GB | Target estimate |
| Collector + Phoenix | 256 MB + 1 GB; off when unused, roughly 1 GB active | Target estimate |
| Host Factory | At most 2 worktrees; peak 1.5–2.5 GB | Target estimate |
| Whole laptop / disk | Daytime 11–13.5 GB, peak 14–16 GB with swap; reserve 15–25 GB disk | Target estimate |

Measure docker stats and OrbStack for one week before treating limits as validated.

**Current operations tooling:** [container guide](CONTAINER_SETUP.md),
[rollback](ROLLBACK.md) and optional macOS Slack watchdog; health, backup and
rollback commands exist. Their presence is not evidence of a healthy deployment.
**Target operations:** keep power and prevent sleep (caffeinate -s or Amphetamine),
start OrbStack → Friday Compose → Hermes machine, use restart: unless-stopped and
systemd, enable Phoenix only when needed, check quota weekly. Back up Friday state,
push the separate vault, encrypt external Hermes snapshots. Pin OpenClaw/Codex/
Claude Code/Hermes; upgrade one at a time and rerun acceptance. Clean jobs older
than 30 days, merged worktrees and obsolete images under human-owned operations.
**Deferred:** a second always-on machine if closed-laptop availability or repeated
RAM peaks require it; Factory stays on the laptop.

## 11. Decisions

| # | Decision | Rejected alternative / reason | Status |
| --- | --- | --- | --- |
| 1 | Keep OpenClaw for Friday | Replacing TypeScript plugins/Shield with shell-capable Hermes | Current |
| 2 | One Hermes, three Bot Mode profiles | Two full instances; separate memory/environment/skills with one update/auth boundary | Target; isolation proof required |
| 3 | OrbStack isolated machine | Ordinary container/machine sees wider host surface | Target; shared-kernel limit |
| 4 | Learning handoff by folders | Friday–Hermes API/network would undermine isolation | Target |
| 5 | Markdown vault + FTS5 | Vector DB before measured retrieval failures | Target; vector DB Deferred until eval proves need |
| 6 | Codex executor, Claude only Factory | Runtime Claude cross-review under Pro quota/billing uncertainty | Target; P5 Deferred until Max and eval |
| 7 | Orca for Factory | OpenRig duplicates roles and alters shared config | Target workflow, Orca worktree used |
| 8 | Defer decision model; no Clef on laptop | Clef-flash RAM/deployment uncertainty; Jev requires new API key | Deferred until separate hardware and subscription-compatible proof; laptop/API-key path Prohibited |
| 9 | Per-source fixed docs tool | Arbitrary Friday web search/fetch adds injection and credential risk | Target; generic fetch Prohibited |
| 10 | Metadata-only AWS role with data Deny and Roles Anywhere | ReadOnlyAccess/data exposure, static keys, general AWS MCP | Target; broad data/static-key paths Prohibited |
| 11 | Friday investigates; human remediates | Pipeline retry, rollback, restart via Friday | Current read-only boundary; Target SRE; remediation Prohibited |

**Deferred inherited decisions:** LangGraph only after durable branching/pause/replay
cannot remain clear in deterministic OpenClaw services; OPA only if centralized
policy complexity justifies it within approved scope; LiteLLM only if actual API
routing needs arise under a separately revised subscription-only decision. None
may widen Friday authority or imply new AI API keys now.

## 12. Open verification before deployment

- **Target:** prove OrbStack read-only jobs mounts. If unsupported, review a
  host-owned copy mechanism between separate producer/consumer folders.
- **Target:** prove Hermes per-bot terminal/web/dispatch denial, disabled learner
  personal memory, inactive generated skills, owner-only Telegram and operation
  without Desktop. Otherwise separate learner into another isolated machine.
- **Target:** measure Hermes Codex OAuth quota; verify pinned versions/model IDs.
- **Validated declarations / Target runtime:** prove agent_end job hook and real
  trace emission/correlation. Current metadata retention does not close the
  trace-continuity plan’s later tasks or deployment gate.
- **Target:** close docs WIP review findings in ROADMAP before adopting adapter;
  prove port/userinfo/redirect rejection and actual untrusted wrapping. Consider
  a domain proxy only if evidence warrants a stronger egress boundary.
- **Target, human:** obtain Everfit approval for PR data processing/subscription
  use and all AWS/Datadog/Kubernetes access; verify OrbStack licensing.
- **Target:** check AWS Config/Resource Explorer enablement and costs.
- **Target:** review sample IAM with Access Analyzer, resource scopes and remaining
  data-bearing actions; verify exact Datadog read scopes and Kubernetes RBAC/token
  rotation.
- **Target:** measure RAM for a week and quota for two weeks; define log-query cost
  ceilings and candidate-quality eval thresholds.
- **Target:** settle learner/researcher notification credential ownership, expired
  lesson removal and storage migration details in approved plans.
