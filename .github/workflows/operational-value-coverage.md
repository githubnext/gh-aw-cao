---
name: "Value Coverage"
description: Disabled registration-only placeholder for a separately reviewed feature-ref run.
intent: Make the workflow discoverable without authorizing or executing coverage work.
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
discovery. The unconditional false activation condition must remain in place.
Manual dispatch of this revision must never invoke a model, dispatch work, or
write safe outputs. Do not perform any task if these instructions are reached.

The dispatch envelope matches feature commit
`7ef2cbc5311c3acdc2e1f8f6b1532cf14b922e36`. Registration is not campaign
installation or activation. A separately authorized test must explicitly select
a reviewed full-implementation ref and satisfy that ref's policy and active-plan
requirements; dispatching `main` cannot test coverage.
