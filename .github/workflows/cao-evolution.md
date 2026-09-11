---
name: "CAO Evolution"

description: "Maintains the integrity, reliability, and efficiency of Central Agentic Ops control planes"
intent: Maintain trustworthy, reliable, and cost-efficient CAO control planes without duplicating target-repository operations or maintainer work.

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
      dispatch_max: 3
      orchestrator_credits: 250
      worker_credits_per_target: 1300

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
    workflows: [cao-evolution-integrity, cao-evolution-reliability, cao-evolution-efficiency]
    max: 3
  threat-detection: false
---

{{#runtime-import? .github/cao/cao-evolution.md}}

# CAO Evolution

Maintain repositories that operate a Central Agentic Ops control plane. Select control repositories only; target-repository maintenance remains owned by the packages dispatched from those control planes.

## Discovery

Read `/tmp/gh-aw/agent/control-precompute.json` before selecting repositories. Treat its candidate repositories, effective maximum, resolved mode, safe-output repository, and worker eligibility as authoritative.

Select a repository only when its default branch contains `.github/workflows/cao.json` and CAO runtime evidence under `.github/cao/` or installed package records under `.github/aw/packages/`. Verify the evidence through read-only repository tools. Do not infer control-plane status from the repository name, catalog manifests, or target-repository files.

Prioritize control repositories with one or more of these signals:

1. Invalid or drifting CAO policy, worker registrations, package ownership, target authority, or installed workflow sources.
2. Recent CAO admission, orchestration, dispatch, worker, activity-cache, dashboard-build, or data-health failures.
3. Repeated no-op or incomplete runs, duplicate evidence acquisition, overlapping schedules, high API pressure, or AI Credit allocation that is disproportionate to attained operational value.
4. Recent policy, package, workflow, credential-boundary, or dashboard changes that have not yet been checked together.

Skip archived repositories, repositories without a readable default branch, ordinary target repositories, catalogs that do not run a control plane, and repositories whose control-plane evidence is incomplete. Report incomplete evidence rather than widening discovery.

## Workers

- `cao-evolution-integrity`: checks policy/schema validity, authority boundaries, package and worker registration, installed-source ownership, rollout consistency, and dashboard/control-model drift.
- `cao-evolution-reliability`: checks the last 24 full hours of CAO admission, dispatch, worker, activity-cache, review-bundle, dashboard-build, and dashboard-data-health evidence for actionable recurring failures.
- `cao-evolution-efficiency`: checks portfolio-level dispatch yield, no-op and incomplete rates, duplicate acquisition, schedule overlap, API pressure, and AI Credit allocation. It does not duplicate per-workflow prompt or ambient-context optimization owned by `optimization`.

Dispatch each eligible worker at most once for each selected repository and effective mode. Do not retry a failed dispatch in the same run. Workers own repository analysis and all durable outputs.

## Completion

Finish with the standard `## Orchestrator Report` inherited from `shared/control.md`. Preserve every standard heading and field: `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome`. Use `0`, `none`, or `not applicable` for empty fields, use the exact precomputed repository totals, and distinguish eligible, selected, skipped, and deferred repositories.

Add the control-plane evidence supporting each selection or skip after the standard fields. If no verified control repository needs a worker dispatch and no incomplete condition applies, call `noop` exactly once with the complete orchestrator report as its message.