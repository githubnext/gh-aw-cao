---
name: "Value Coverage / Skill"
description: Propose evidence-backed operational-value skill improvements without self-modification.
intent: Reduce recurring measurement defects while preserving frozen contracts and independent evidence.
tracker-id: value-coverage-skill
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
      worker: skill
      read_repository: ${{ inputs.target_repo }}
      read_contents: read
      read_actions: read
      read_issues: read
      read_pull_requests: read
  - uses: shared/value-coverage-worker.md
safe-outputs:
  create-pull-request:
    allowed-files:
      - ".github/skills/add-operational-value/**"
      - "tests/unit/*operational-value*.test.mjs"
      - "operational-value-coverage/proposals/**"
---

Select at most one recurring defect supported by at least two immutable work
keys/independent validation failures. No such evidence or an open equivalent
proposal is a noop. Produce a red/green regression, minimal helper/skill patch,
version-change rationale, compatibility analysis and predecessor preservation.
Follow the pinned skill's improvement procedure and patch its canonical
instructions/helpers, not a competing campaign implementation. Exercise the
skill copied outside CAO as well as the campaign adapter; retain schema 3 and
update the skill metadata version when behavior changes.
Verify the existing File Diet reporting contract still holds without rerunning
it as new coverage. Test missing/malformed evidence, genuine zero, partial
progress, attribution and historical gaps.

Never rewrite the active plan, ledger, frozen workflow functions, observations,
acceptance predicates or published index. Never install the proposed skill in
this run or retroactively rescore existing work. Human review and merge, then a
new plan with new dependency pins, are required before subsequent cohorts can
use the improvement. In-flight work remains on its prior pinned version.

{{#runtime-import? .github/cao/operational-value-coverage.md}}
