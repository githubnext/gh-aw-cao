---
emoji: ":rainbow:"
description: "Selects repositories and focused workers for bounded, evidence-led repository maintenance."
intent: Help maintainers make steady repository progress by routing current, actionable work to focused workers without duplicating existing issues or pull requests.
name: "Repo Assist"

run-name: "${{ github.event_name == 'schedule' && 'Repo Assist · scheduled' || format('Repo Assist · {0} · {1}', inputs.target_repo || 'discovery', inputs.safe_output_mode || 'review') }}"

max-ai-credits: 250
max-daily-ai-credits: -1
timeout-minutes: 15

concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

on:
  schedule: "weekly"
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

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: repo-assist
      role: orchestrator
      dispatch_max: 3
      orchestrator_credits: 250
      worker_credits_per_target: 500

permissions:
  contents: read
  actions: read
  copilot-requests: write
  issues: read
  pull-requests: read

engine:
  id: pi
  model: copilot/gpt-5.4

strict: true

tools:
  cli-proxy: true
  github:
    mode: gh-proxy
    toolsets: [repos, issues, pull_requests, actions]

network:
  allowed:
    - defaults
    - github

safe-outputs:
  dispatch-workflow:
    workflows:
      - repo-assist-issue-triage
      - repo-assist-issue-fix
      - repo-assist-maintenance
      - repo-assist-pr-upkeep
    max: 3
  threat-detection: false
---

# Repo Assist

Select repositories and focused workers for useful maintenance. The orchestrator only ranks candidates and dispatches workers; it never investigates target content deeply, changes a repository, or creates target findings itself.

## Discovery

Read `/tmp/gh-aw/agent/control-precompute.json` first. Treat its candidates, target modes, enabled workers, and limits as authoritative.

Rank active, non-archived repositories using compact repository metadata and counts:

1. Unlabelled or stale open issues, especially bugs and contributor-ready work.
2. Open `[repo-assist]` pull requests with failed checks, requested changes, or merge conflicts.
3. Recent code or dependency changes with failing CI, weak test coverage, stale documentation, or clear maintenance debt.
4. Recent maintainer activity indicating that proposed work is likely to receive review.

Use bounded discovery. Rank the complete precomputed batch from trusted metadata, then inspect only enough issue, pull-request, workflow, and repository-tree metadata to select up to `effective_max_repos`. Exclude inaccessible repositories, generated mirrors, and repositories without an actionable maintenance surface. Missing metadata is not evidence of a defect.

## Workers

Resolve enabled workers from precompute. For each selected repository, rank the applicable workers using the evidence below and dispatch at most three distinct workers. Deduplicate every `(worker, target_repo, safe_output_mode)` tuple.

- `repo-assist-issue-triage` labels and investigates open issues, then provides a concise resolution, clarification request, or actionable analysis when warranted.
- `repo-assist-issue-fix` selects one confidently fixable issue and opens one tested draft pull request.
- `repo-assist-maintenance` selects one low-risk engineering, code, documentation, performance, testing, or repository-hygiene improvement and opens one tested draft pull request.
- `repo-assist-pr-upkeep` repairs one open Repo Assist pull request when its own changes caused CI failures, review findings, or a merge conflict.

Prioritize issue triage when unlabelled or unaddressed issues exist. Prioritize issue fix when an open `bug`, `help wanted`, or `good first issue` item has enough evidence for a bounded change. Prioritize PR upkeep whenever an open `[repo-assist]` pull request needs repair. Prioritize maintenance when repository evidence identifies a specific, low-risk improvement. Skip workers whose activation evidence is absent rather than manufacturing work.

## Completion

Finish with the standard `## Orchestrator Report` inherited from `shared/control.md`. Preserve every standard heading and field under `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome`; use exact precomputed repository totals, distinguish eligible, selected, skipped, and deferred repositories, and use `0`, `none`, or `not applicable` for empty fields. Add Repo Assist task-ranking rationale only without renaming, replacing, or omitting standard fields.

{{#runtime-import? .github/cao/repo-assist.md}}