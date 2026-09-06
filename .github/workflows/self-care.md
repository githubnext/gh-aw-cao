---
name: "SelfCare"

run-name: "${{ github.event_name == 'schedule' && 'SelfCare · scheduled' || format('SelfCare · {0} · {1}', inputs.target_repo || github.repository, inputs.safe_output_mode || 'review') }}"

max-ai-credits: 200
max-daily-ai-credits: -1
timeout-minutes: 15

concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

on:
  schedule: every 20 minutes
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
      package: self-care
      role: orchestrator
      dispatch_max: 9
      orchestrator_credits: 200
      worker_credits_per_target: 2400

  - uses: shared/dispatcher.md
permissions:
  contents: read
  actions: read
  copilot-requests: write

engine: copilot
model: copilot/gpt-5.4

strict: true

tools:
  github:
    mode: remote
    min-integrity: approved
    toolsets: [repos, actions]

network:
  allowed:
    - defaults
    - github

safe-outputs:
  dispatch-workflow:
    workflows: [self-care-accessibility-checker, self-care-code-improvement, self-care-dashboard-performance, self-care-data-acquisition-audit, self-care-dashboard-language-refactor, self-care-dashboard-review, self-care-docs-build-time-investigator, self-care-open-source-failures, self-care-primer-brand-checker]
    max: 9
  threat-detection: false

source: githubnext/gh-aw-cao@a4b937e2ee4e540d3ccce1377f8943315670f33d
---

{{#runtime-import? .github/cao/self-care.md}}

# SelfCare

## Discovery

This operation is exclusively for `githubnext/gh-aw-cao`. Select that repository only when its precomputed candidate mode is `live`. Treat every other repository and every non-live candidate as ineligible, regardless of apparent need, and record the skip reason in the standard report.

The single eligible repository contains the documentation site and dashboard maintained by the nine workers. Do not discover, rank, or dispatch work to any other repository.

## Workers

- `self-care-accessibility-checker`: audits the rendered documentation site with axe-core, keyboard traversal, and browser evidence, then publishes one prioritized accessibility issue.
- `self-care-code-improvement`: extracts one evidenced duplicated dashboard UI construct into a tested reusable component and opens one focused draft pull request.
- `self-care-dashboard-performance`: rotates through trace-backed CFO, CTO, and CSO Lighthouse bottlenecks and opens one focused draft pull request.
- `self-care-dashboard-review`: uses deterministic checks and CFO, CSO, and CTO browser journeys to assess dashboard correctness, decision support, efficiency, and usability.
- `self-care-docs-build-time-investigator`: analyzes Documentation Pages workflow timing evidence and opens one issue with a non-repeating caching or dashboard build-speed improvement.
- `self-care-data-acquisition-audit`: reviews gh-aw logs, GitHub API access, predownloads, indexing, and caching, then opens one focused draft pull request when the acquisition audit is stale.
- `self-care-dashboard-language-refactor`: replaces one over-specialized dashboard view with tested reusable subcomponents configured through Dashboard Language and opens one focused draft pull request.
- `self-care-open-source-failures`: scans the dashboard activity snapshot for clustered failures across represented public projects and files one digest plus focused remediation issues.
- `self-care-primer-brand-checker`: audits the dashboard against retrieved Primer brand guidance and opens one focused draft pull request when an evidenced presentational fix is available.

Dispatch all nine enabled workers for the selected repository. Never dispatch a worker in review mode or for another repository.

## Completion

Finish with the standard orchestrator report inherited from `shared/dispatcher.md`. Preserve `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome`, including every standard field. Use exact precomputed totals for repositories scanned and distinguish eligible, selected, skipped, and deferred repositories. Use `0`, `none`, or `not applicable` for every empty field.

In `Outcome`, additionally state whether the sole authorized live target was selected and whether all nine SelfCare workers were dispatched.
