---
emoji: ":mag:"

description: "Review-only verification of one authoritative applied token-efficiency intervention"

name: "AW Optimization / Token Efficiency Verifier"

max-ai-credits: 50
max-daily-ai-credits: -1

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
      max_repos:
        type: number
      rollout_percent:
        type: number
      safe_output_mode:
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
      opportunity_id:
        required: true
        type: string
      intervention_id:
        required: true
        type: string
      evidence_cutoff:
        required: true
        type: string
  permissions:
    contents: read
    actions: read

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
  activation:
    outputs:
      verification_eligible: ${{ steps.verification_eligibility.outputs.eligible }}
      verification_reason: ${{ steps.verification_eligibility.outputs.reason }}
    pre-steps:
      - name: Validate one declarative verification request
        id: verification_eligibility
        env:
          TARGET_REPOSITORY: ${{ inputs.target_repo }}
          OPPORTUNITY_ID: ${{ inputs.opportunity_id }}
          INTERVENTION_ID: ${{ inputs.intervention_id }}
          EVIDENCE_CUTOFF: ${{ inputs.evidence_cutoff }}
          REQUESTED_MODE: ${{ inputs.safe_output_mode }}
        run: |
          set -euo pipefail
          eligible=false
          reason=invalid-verification-request

          if [ -n "$REQUESTED_MODE" ] && [ "$REQUESTED_MODE" != review ]; then
            reason=review-mode-required
          elif ! jq -en \
              --arg target "$TARGET_REPOSITORY" \
              --arg opportunity "$OPPORTUNITY_ID" \
              --arg intervention "$INTERVENTION_ID" \
              --arg cutoff "$EVIDENCE_CUTOFF" '
                ($target | test("^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$"))
                and ($opportunity | startswith("token-opportunity:"))
                and ($intervention | startswith("token-intervention:" + $opportunity + ":"))
                and ($cutoff | fromdateiso8601? != null)
              ' >/dev/null; then
            reason=invalid-verification-selectors
          else
            eligible=true
            reason=eligible
          fi

          echo "eligible=$eligible" >> "$GITHUB_OUTPUT"
          echo "reason=$reason" >> "$GITHUB_OUTPUT"
  agent:
    if: ${{ false }}

imports:
  - uses: shared/control.md
    with:
      campaign: optimization
      role: worker
      worker: token-efficiency-verifier

permissions:
  contents: read
  actions: read
  copilot-requests: write

strict: true

network:
  allowed:
    - defaults
    - github

run-name: "Token Efficiency Verifier · ${{ inputs.target_repo }} · review"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.intervention_id }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

tracker-id: optimization-token-efficiency-verifier

tools:
  bash:
    - "*"

timeout-minutes: 10

source: githubnext/gh-aw-cao/.github/workflows/optimization-token-efficiency-verifier.md@main
---

# AW Optimization / Token Efficiency Verifier

This workflow has no model task. The activation job validates one bounded,
review-only verification request. The Optimization dashboard derives matured
comparisons from canonical lifecycle, assignment, grader, usage, and Run
sources through Dashboard Language queries. The worker never checks out or
writes to the target repository and does not parse or transform dashboard data.

{{#runtime-import? .github/cao/optimization.md}}
