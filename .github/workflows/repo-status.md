---
name: "Repo Status"
description: "Selects enrolled repositories for a bounded daily activity report."
intent: Help maintainers understand recent repository progress and choose the next useful action without duplicate status noise.
run-name: "Repo Status · ${{ inputs.target_repo || 'discovery' }} · ${{ inputs.safe_output_mode || 'review' }}"

max-ai-credits: 150
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
        options: [review, live]
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

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      campaign: repo-status
      role: orchestrator
      read_repository: ${{ github.repository }}
      dispatch_max: 10
      orchestrator_credits: 150
      worker_credits_per_target: 300
      read_actions: read
      read_contents: read
      read_issues: read

permissions:
  contents: read
  actions: read
  issues: read
  copilot-requests: write

engine: copilot
strict: true

tools:
  github:
    mode: gh-proxy
    toolsets: [repos, issues, actions]
  repo-memory:
    branch-name: "memory/repo-status"

network:
  allowed: [defaults, github]

safe-outputs:
  dispatch-workflow:
    workflows: [repo-status-report]
    max: 10
  threat-detection: false
---

# Repo Status

Select and rank repositories for a useful daily status report. Only the
`repo-status-report` worker gathers activity and writes reports. Do not analyze
target work, create reports, or change target repositories here.

## Discovery

Read `/tmp/gh-aw/agent/control-precompute.json` first. Use only its complete
candidate batch, per-target modes, enabled workers, output destinations and
`effective_max_repos`. An explicit admitted `target_repo` takes priority.

Read and use `$GH_AW_MEMORY_DIR` before selection. Keep at most 100 advisory
records of target, worker, mode, last dispatch time and UTC reporting date;
discard records older than seven days. Never store source, issue bodies, logs,
credentials or policy. Memory is advisory, not proof of completion or authority.
Confirm a report's current existence before skipping a target on that basis.

Rank non-archived, non-disabled, readable candidates by recent repository
activity and the oldest missing daily report. Prefer candidates not dispatched
for the previous complete UTC day. Use precomputed metadata and at most one
bounded report lookup per candidate; do not gather the report's activity here.
Do not exclude a repository merely because it has no open issues or PRs.
Missing metadata is unknown, not inactivity.

## Workers

Dispatch `repo-status-report` at most once per selected repository, no more than
`effective_max_repos` repositories and ten dispatches total. Deduplicate every
`(worker, target_repo, safe_output_mode)` tuple. Use the full shared-control
envelope and each target-and-worker pair's resolved mode and destination; never
replace a worker ceiling with the campaign default. Do not retry a failed
dispatch in this run.

## Completion

Finish with the standard `## Orchestrator Report` inherited from
`shared/control.md`, preserving `Scope`, `Repository Decisions`, `Workers`,
`Dispatches` and `Outcome`. Distinguish dispatched work from completed reports.
If no candidate needs a report, call `noop`; missing access or required evidence
is incomplete, not a healthy no-op.

{{#runtime-import? .github/cao/repo-status.md}}
