---
name: Fleet Audit
description: A standalone CAO governance compilation fixture.
intent: Give maintainers a bounded repository inventory report without requiring a campaign.
on:
  workflow_dispatch:
    inputs:
      target_repo:
        type: string
      safe_output_repo:
        type: string
      safe_output_mode:
        type: choice
        options: [review, live]
      max_repos:
        type: number
      rollout_percent:
        type: number
  permissions:
    contents: read
    actions: read
permissions:
  contents: read
  actions: read
  issues: read
  copilot-requests: write
strict: true
engine: copilot
max-ai-credits: 100
timeout-minutes: 10
jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
if: needs.pre_activation.outputs.cao_authorized == 'true'
imports:
  - uses: shared/control.md
    with:
      role: standalone
      workflow: fleet-audit
      read_repository: ${{ github.repository }}
      read_contents: read
      read_issues: read
env:
  SAFE_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
network:
  allowed: [defaults, github]
tools:
  github:
    mode: gh-proxy
    toolsets: [repos, issues]
safe-outputs:
  create-issue:
    target-repo: "${{ inputs.safe_output_repo || github.repository }}"
    max: 1
---

Read the CAO precompute record. In review mode, summarize only the admitted
repository metadata in one issue in the admitted review repository. Search for
an equivalent open report before publishing; call `noop` when one already
exists. This fixture declares no live target output path: report incomplete
instead of publishing a live candidate's report to another repository.
