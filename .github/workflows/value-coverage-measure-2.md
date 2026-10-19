---
name: "Value Coverage / Measure 2"
description: Disabled registration-only placeholder for a separately reviewed feature-ref run.
intent: Make the workflow discoverable without authorizing or executing coverage work.
on:
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
if: "false"
max-daily-ai-credits: -1
concurrency:
  job-discriminator: ${{ github.run_id }}
permissions:
  contents: read
checkout: false
network:
  allowed: []
tools:
  cli-proxy: false
  github: false
  bash: false
  edit: false
safe-outputs:
  create-issue: false
  noop:
  missing-tool: false
  missing-data: false
  report-incomplete: false
  report-failure-as-issue: false
  report-failed-jobs: false
---

# Registration only

This temporary default-branch stub reserves the workflow path for GitHub Actions
discovery. Its unconditional false activation condition must remain in place.
Never measure, invoke a model, dispatch work, or write safe outputs here.
The dispatch envelope matches feature commit
`7ef2cbc5311c3acdc2e1f8f6b1532cf14b922e36`; see
`operational-value-coverage.md` for the separate feature-ref test prerequisites.
