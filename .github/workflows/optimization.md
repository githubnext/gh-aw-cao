---
name: "AW Optimization"

run-name: "${{ github.event_name == 'schedule' && 'AW Optimization · scheduled' || format('AW Optimization · {0} · {1}', inputs.target_repo || 'discovery', inputs.safe_output_mode || 'review') }}"

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

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || '' }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

environment: central-agentic-ops

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: optimization
      role: orchestrator
      dispatch_max: 20
      orchestrator_credits: 250
      worker_credits_per_target: 1650

permissions:
  contents: read
  actions: read
  copilot-requests: write

strict: true

tools:
  github:
    mode: remote
    toolsets: [repos, actions]

network:
  allowed:
    - defaults
    - github

safe-outputs:
  dispatch-workflow:
    workflows: [optimization-ai-credit-auditor, optimization-ai-credit-optimizer, optimization-agents-md-curator, optimization-skills-curator]
    max: 20
  threat-detection: false

source: githubnext/gh-aw-cao@2de9130ff1709fccdacbe5261fd5da71995e6721
---

{{#runtime-import? .github/cao/optimization.md}}

# AW Optimization

## Discovery

For the AW Optimization package, prefer repositories where Agentic Workflows can be made cheaper or their ambient context can be made smaller and more accurate. Strong signals include Agentic Workflow definitions under `.github/workflows/`, recent AI credit usage, high-turn or high-token runs, repeated warnings or failures, existing audit history, or a root `AGENTS.md` that has drifted while the repository kept changing.

Before dispatching an ambient-context worker, confirm the default branch contains a root `AGENTS.md`; never dispatch those workers to propose creating one. Prefer drift evidenced by stale paths or commands, oversized or duplicated instructions, contradictions among instruction files, repeated reviewer corrections, or skills with weak descriptions or unclear use.

Deprioritize repositories with neither Agentic Workflow definitions nor a root `AGENTS.md`, unreadable workflow logs, no recent agentic activity or repository changes, open pull requests already modifying ambient context, or only the optimization monitoring workflows installed without other workflows to improve.

## Workers

- `optimization-ai-credit-auditor`: reads workflow definitions and recent run logs; records AI credit and token snapshots with trend charts, then uses `gh aw forecast` to report weekly and monthly AIC and estimated USD scenarios.
- `optimization-ai-credit-optimizer`: reads 7-day run aggregates and repo-memory history; publishes recommendations for the highest-impact workflow not recently optimized.
- `optimization-agents-md-curator`: reads a repository's root `AGENTS.md`, git history, and merged pull request and review-comment history; files one issue containing an agentic prompt for a small, evidence-backed update.
- `optimization-skills-curator`: reads agent skills, agent definitions, and their in-repository references; files one issue containing an agentic prompt that improves the layering between `AGENTS.md` and skills.

Dispatch stays repository-scoped: one dispatch per selected repository and eligible worker. The ambient-context workers apply their existing 10 percent gain gate before publishing and return a `noop` when the estimated reduction in always-loaded context is smaller.

## Completion

Finish with the standard `## Orchestrator Report` inherited from `shared/control.md`. Preserve every standard heading and field — `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome` — and use `0`, `none`, or `not applicable` for empty fields. Use the exact precomputed repository totals and distinguish eligible, selected, skipped, and deferred repositories.

If no worker is dispatched and no incomplete condition applies, call `noop` exactly once with the complete orchestrator report as its message.

Add package-specific details after the standard fields:

- The optimization or ambient-context signal that justified each selected repository.
- Repositories skipped for ambient-context work because they have no root `AGENTS.md`.