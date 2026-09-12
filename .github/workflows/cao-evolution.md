---
name: "CAO Evolution"

description: "Maintains the integrity, reliability, efficiency, and agentic-workflow health of Central Agentic Ops repositories"
intent: Maintain trustworthy, reliable, safe, and cost-efficient CAO control planes and their enrolled agentic workflows without duplicating target-repository operations or maintainer work.

run-name: "${{ github.event_name == 'schedule' && 'CAO Evolution · scheduled' || format('CAO Evolution · {0} · {1}', inputs.target_repo || 'discovery', inputs.safe_output_mode || 'review') }}"

max-ai-credits: 250
max-daily-ai-credits: -1
timeout-minutes: 15

concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

on:
  schedule: "hourly"
  workflow_dispatch:
    inputs:
      target_repo:
        type: string
      safe_output_repo:
        type: string
      max_repos:
        default: 1
        type: number
      rollout_percent:
        default: 100
        type: number
      safe_output_mode:
        default: "review"
        type: choice
        options:
          - review
          - live
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
  permissions:
    contents: read
    actions: read

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || '' }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

environment: central-agentic-ops

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: cao-evolution
      role: orchestrator
      dispatch_max: 5
      orchestrator_credits: 250
      worker_credits_per_target: 2300

permissions:
  contents: read
  actions: read
  copilot-requests: write
  issues: read

strict: true

tools:
  github:
    mode: remote
    toolsets: [repos, issues, actions]

network:
  allowed:
    - defaults
    - github

safe-outputs:
  dispatch-workflow:
    workflows: [cao-evolution-integrity, cao-evolution-reliability, cao-evolution-efficiency, aw-failures-investigator, aw-maintenance-compiler-security]
    max: 5
  threat-detection: false
---

{{#runtime-import? .github/cao/cao-evolution.md}}

# CAO Evolution

Maintain repositories that operate a Central Agentic Ops control plane and the policy-enrolled repositories whose agentic workflows must remain reliable and safe. Control-plane workers remain limited to verified control repositories; agentic-workflow health workers may run against other enrolled repositories with verified gh-aw adoption.

## Discovery

Read `/tmp/gh-aw/agent/control-precompute.json` before selecting repositories. Treat its candidate repositories, effective maximum, resolved mode, safe-output repository, and worker eligibility as authoritative.

Classify each candidate using read-only repository evidence:

- A **control repository** has `.github/workflows/cao.json` plus CAO runtime evidence under `.github/cao/` or installed package records under `.github/aw/packages/`.
- An **agentic-workflow repository** has editable `.github/workflows/*.md` sources or an `aw.yml` package manifest.

Do not infer either role from the repository name. A repository may have both roles.

Prioritize control repositories with one or more of these signals:

1. Invalid or drifting CAO policy, worker registrations, package ownership, target authority, or installed workflow sources.
2. Recent CAO admission, orchestration, dispatch, worker, activity-cache, dashboard-build, data-health, or agentic-workflow failures.
3. Agentic workflow sources that need compiler, validation, image, or security-scanner verification.
4. Repeated no-op or incomplete runs, duplicate evidence acquisition, overlapping schedules, high API pressure, or AI Credit allocation that is disproportionate to attained operational value.
5. Recent policy, package, workflow, credential-boundary, or dashboard changes that have not yet been checked together.

Skip archived repositories, repositories without a readable default branch, repositories with neither verified role, and repositories whose evidence is incomplete. Report incomplete evidence rather than widening discovery.

## Workers

- `cao-evolution-integrity`: checks policy/schema validity, authority boundaries, package and worker registration, installed-source ownership, rollout consistency, and dashboard/control-model drift.
- `cao-evolution-reliability`: checks the last 24 full hours of CAO admission, dispatch, worker, activity-cache, review-bundle, dashboard-build, and dashboard-data-health evidence for actionable recurring failures.
- `cao-evolution-efficiency`: checks portfolio-level dispatch yield, no-op and incomplete rates, duplicate acquisition, schedule overlap, API pressure, and AI Credit allocation. It does not duplicate per-workflow prompt or ambient-context optimization owned by `optimization`.
- `aw-failures-investigator`: checks recent agentic workflow runs and failure logs, groups failures by error signature, and publishes focused fix issues for uncovered failure clusters.
- `aw-maintenance-compiler-security`: compiles all agentic workflows with strict validation, linters, image checks, and the full gh-aw security-scanner suite, then publishes one deduplicated findings report with a local agent fixing loop.

Dispatch the integrity, reliability, and efficiency workers only for verified control repositories. Dispatch the failure investigator and compiler-security workers only for verified agentic-workflow repositories. Dispatch each eligible worker at most once for each selected repository and effective mode. Do not retry a failed dispatch in the same run. Workers own repository analysis and all durable outputs.

## Completion

Finish with the standard `## Orchestrator Report` inherited from `shared/control.md`. Preserve every standard heading and field: `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome`. Use `0`, `none`, or `not applicable` for empty fields, use the exact precomputed repository totals, and distinguish eligible, selected, skipped, and deferred repositories.

Add the control-plane evidence supporting each selection or skip after the standard fields. If no verified control repository needs a worker dispatch and no incomplete condition applies, call `noop` exactly once with the complete orchestrator report as its message.