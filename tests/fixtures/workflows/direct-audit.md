---
name: Direct Audit
description: Compile-tested CAO operation without campaign or fleet topology.
intent: Review an explicit bounded repository set without discovering or dispatching more work.
on:
  workflow_dispatch:
    inputs:
      target_repo:
        type: string
      target_repos:
        type: string
        description: JSON array of explicit repositories, review mode only.
      safe_output_repo:
        type: string
      safe_output_mode:
        type: choice
        options: [review, live]
        default: review
      max_repos:
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
concurrency:
  job-discriminator: ${{ github.run_id }}
jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
if: needs.pre_activation.outputs.cao_authorized == 'true'
imports:
  - uses: shared/operation.md
    with:
      workflow: direct-audit
      read_repository: ${{ inputs.target_repo || github.repository }}
      read_contents: read
      read_issues: read
env:
  SAFE_OUTPUT_REPO: ${{ inputs.safe_output_mode == 'live' && inputs.target_repo || inputs.safe_output_repo || github.repository }}
network:
  allowed: [defaults, github]
tools:
  github:
    mode: gh-proxy
    toolsets: [repos, issues]
safe-outputs:
  create-issue:
    target-repo: "${{ inputs.safe_output_mode == 'live' && inputs.target_repo || inputs.safe_output_repo || github.repository }}"
    max: 1
---

Read the precompute record and review metadata for the admitted candidates only.
Produce one concise report using the admitted destination and compiled safe
output. Search for an equivalent existing report and call `noop` when nothing
new warrants publication. Do not discover repositories or dispatch work.
