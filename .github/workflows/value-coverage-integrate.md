---
name: "Value Coverage / Integrate"
description: Independently validate staged native reports and propose serial integration.
intent: Keep the coverage report reproducible, complete and honest about unknown outcomes.
tracker-id: value-coverage-integrate
strict: true
timeout-minutes: 45
max-ai-credits: 500
max-daily-ai-credits: -1
if: needs.pre_activation.outputs.cao_authorized == 'true'
jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
  copilot-requests: write
concurrency:
  group: "${{ github.workflow }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: false
on:
  bots: ["github-actions[bot]", "cao-githubnext-gh-aw-cao-write[bot]"]
  workflow_dispatch:
    inputs:
      target_repo:
        required: true
        type: string
      safe_output_repo:
        required: true
        type: string
      safe_output_mode:
        required: true
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
  permissions:
    contents: read
    actions: read
imports:
  - uses: shared/control.md
    with:
      campaign: operational-value-coverage
      role: worker
      worker: integrate
      read_repository: ${{ inputs.target_repo }}
      read_contents: read
      read_actions: read
      read_issues: read
      read_pull_requests: read
  - uses: shared/activity-cache.md
  - uses: shared/value-coverage-worker.md
safe-outputs:
  create-pull-request:
    allowed-files:
      - ".github/cao/operational-value-coverage/receipts.json"
      - "operational-value-coverage/integration/**"
      - "docs/operational-value/**"
      - "scripts/*operational-value*.mjs"
      - "scripts/build-gh-aw-value-portfolio.mjs"
      - "tests/unit/*operational-value*.test.mjs"
---

You are the single integration/publishing proposal owner. Select at most one
submitted cohort of five workflows. Never author its native acceptance or
accept your own measurement. Stage proposed reports from the exact PR commit;
do not execute unreviewed PR code. Require human merge of code/contracts before
running them. Verify plan, dependency closure, source blob, cutoff and artifact
digests. Reject stale contracts or proposed skill changes.

Apply every `reportingChecklist` item in `operational-value-coverage/report.mjs`
against the already-computed daily-file-diet entry and linked artifacts.
Run `report.mjs` for structural/identity/plot parity checks, then the pinned
workflow-specific deterministic replay and independent regression commands.
The structural validator is not evidence that native acceptance is true.
Check the effective executor, adoption/baseline history, predecessors, coverage,
missing/zero distinction, population denominator, safeguard and attribution
limits; do not reuse File Diet's formula. Partial structural progress cannot be
promoted to full attainment. An honest unmeasurable rationale can finish a
disposition, never a native evaluation.

Only after independent validation, propose registrations in the existing
`scripts/build-gh-aw-value-portfolio.mjs` and rebuild its existing portfolio and
plots; do not replace its measurement/reporting system or add dashboard queries.
Keep predecessor reports and immutable evidence. Preserve receipt-strength
subsets without capping other demonstrated contribution. Validate every linked
file and render the complete report locally, with no Pages deployment. Record
the measurement PR's reviewed merge commit and report manifest digest in a
terminal receipt. Human review/merge of this integration PR is the acceptance
boundary; never merge or publish directly.

Use one integration PR at a time. Rebase/revalidate on the latest accepted
index; no last-writer-wins index updates. Record acquisition gaps (including
expired artifacts), attempts and rework visibly. Shared acquisition is a
separate reviewed deterministic producer using the existing skill collector,
at most 200 requests per resumed invocation, one producer per repository/cutoff,
respecting Retry-After and stopping on quota/auth failure. Do not acquire here.
Report accepted native evaluations/hour, measured credits/accepted evaluation
(null without matched costs or positive denominator), and rework fraction.
Do not increase four-lane concurrency without a separately reviewed decision.

{{#runtime-import? .github/cao/operational-value-coverage.md}}
