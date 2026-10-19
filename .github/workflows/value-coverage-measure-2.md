---
name: "Value Coverage / Measure 2"
description: Measure one reviewed cohort in fixed lane two.
intent: Establish independently reproducible native workflow outcomes without hiding missing evidence.
tracker-id: value-coverage-measure-2
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
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
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
      worker: measure-2
      read_repository: ${{ inputs.target_repo }}
      read_contents: read
      read_actions: read
      read_issues: read
      read_pull_requests: read
  - uses: shared/activity-cache.md
  - uses: shared/value-coverage-worker.md
  - uses: shared/value-coverage-measure.md
safe-outputs:
  create-pull-request:
    allowed-files: ["operational-value-coverage/work/measure-2/**"]
---

Your fixed measurement lane is **2**; never choose another lane.

{{#runtime-import? .github/cao/operational-value-coverage.md}}
