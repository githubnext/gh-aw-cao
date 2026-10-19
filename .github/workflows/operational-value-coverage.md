---
name: "Value Coverage"
description: Select bounded reviewed operational-value coverage work without changing rollout authority.
intent: Close workflow measurement and reporting gaps with independently reviewed native evidence and honest dispositions.
max-ai-credits: 150
max-daily-ai-credits: -1
timeout-minutes: 15
on:
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
        options: [review]
  permissions:
    contents: read
    actions: read
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
  copilot-requests: write
strict: true
checkout:
  ref: ${{ github.workflow_sha }}
env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || '' }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}
concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: false
jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
if: needs.pre_activation.outputs.cao_authorized == 'true'
imports:
  - uses: shared/control.md
    with:
      campaign: operational-value-coverage
      role: orchestrator
      read_repository: ${{ github.repository }}
      read_actions: read
      read_contents: read
      read_issues: read
      read_pull_requests: read
      dispatch_max: 6
      orchestrator_credits: 150
      worker_credits_per_target: 3000
  - uses: shared/activity-cache.md
tools:
  repo-memory:
    branch-name: memory/operational-value-coverage
  github:
    mode: remote
    toolsets: [repos, issues, pull_requests, actions]
network:
  allowed: [defaults, github]
safe-outputs:
  dispatch-workflow:
    workflows: [value-coverage-measure-1, value-coverage-measure-2, value-coverage-measure-3, value-coverage-measure-4, value-coverage-integrate, value-coverage-skill]
    max: 6
  threat-detection: false
---

Select and dispatch only; never measure workflows, acquire evidence, edit
contracts or integrate reports. Read `/tmp/gh-aw/agent/control-precompute.json`
first. A disabled campaign, no eligible target, missing/proposed reviewed plan,
non-review mode or mismatched pins is a silent noop with an explicit reason.
This manually triggered campaign has no schedule and must remain disabled
until a separate human-approved rollout change.
The conventional `value-coverage-pump.yml` supplies automatic 15-minute wakeups
after enablement and approval of a full-inventory plan. It introduces no pilot,
additional campaign spending cap or automatic merge.

Read `$GH_AW_MEMORY_DIR` before selection; use bounded advisory work-key/run
references (at most 100, discard after 7 days), never raw evidence or authority.
Read `.github/cao/operational-value-coverage/active.json` and the neighboring
`receipts.json` at this
workflow SHA. Use `coverage.mjs inventory` to reconcile the pinned canonical
input portfolio, not remembered counts. Run `node
operational-value-coverage/sweep.mjs . "$REVIEW_OUTPUT_REPO"` for the shared
ledger/PR/run selection snapshot. Use its `readyCohorts`, `excludedKeys`,
`integrationKeys` and `integrationMarker`; its `dispatch` flag is only for the
external pump and will be false while this orchestrator itself runs. Missing
plan or invalid pins blocks all dispatch. Do not substitute memory for the ledger.

Select at most one policy-admitted repository equal to the plan repository.
Each lane gets at most one cohort, at most five workflows (prefer 3-5 related
workflows when their evidence interfaces are compatible). Preserve per-workflow
contracts. Use four distinct measurement workflow IDs because CAO deduplicates
worker/target/mode tuples; each is repository-serialized, yielding at most four
measurement workers, not unbounded same-worker fan-out. Check open PR work keys
and queued/in-progress Actions runs before dispatch; an occupied lane gets no
new dispatch. An open PR holds only its own work keys, not later ready cohorts
in that lane. Keep idle lanes fed across the entire approved inventory, without
a pilot stage or new per-cohort go/no-go gate. A merged lane PR retaining the work key is submitted work awaiting
integration, even before the global receipt log is updated; suppress measurement
and select integration instead. Blocked, submitted, terminal or twice-attempted work is not ready.

Dispatch integration only when submitted isolated results await validation and
there is no open integration PR/run. Dispatch skill only for recorded recurring
failure evidence and no open skill proposal/run; it must not overlap measurement
work on its pinned skill version. Cap all dispatches at six. Deduplicate
`(worker, target_repo, safe_output_mode)` and never retry failed dispatches.
Pass the full standard envelope, effective review mode and stable plan/cohort
identity in `batch_label`; it is a hint, not authority.

Finish with the inherited standard `## Orchestrator Report`: Scope,
Repository Decisions, Workers, Dispatches, Outcome. Report the reconciled
remaining inventory, ready/deferred/blocked cohorts and approval prerequisites.
Do not claim complete native coverage from complete dispositions.

{{#runtime-import? .github/cao/operational-value-coverage.md}}
