---
name: "SelfCare / Data Acquisition Audit"
description: Re-audits gh-aw logs, GitHub API access, downloads, indexing, and caching.
intent: Keep the data acquisition audit accurate as repository collection paths and rate-limit risks change.
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
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
  skip-if-match: 'is:pr is:open "gh-aw-workflow-id: self-care-data-acquisition-audit" in:body'
  permissions:
    contents: read
    actions: read

checkout:
  repository: ${{ inputs.target_repo }}
  github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
  fetch-depth: 0
  current: true

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

environment: central-agentic-ops

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: self-care
      role: worker
      worker: data-acquisition-audit

  - uses: shared/worker.md
permissions:
  contents: read
  actions: read
  pull-requests: read
  copilot-requests: write
concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true
strict: true
max-ai-credits: 300
max-daily-ai-credits: -1
timeout-minutes: 20
tracker-id: self-care-data-acquisition-audit
run-name: "SelfCare data acquisition audit · ${{ inputs.target_repo }} · ${{ inputs.safe_output_mode || 'review' }}"
tools:
  bash:
    - "*"
safe-outputs:
  create-pull-request:
    target-repo: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
    title-prefix: "[data-acquisition-audit] "
    draft: true
    max: 1
    if-no-changes: ignore
    allowed-files:
      - "specs/data-acquisition-audit.md"
  noop:
---

{{#runtime-import? .github/cao/self-care.md}}

# Data Acquisition Audit Refresher

Read `/tmp/gh-aw/agent/control-precompute.json` first. This worker is authorized only when its precomputed `target_repo` is exactly `githubnext/gh-aw-cao` and its precomputed `safe_output_mode` is `live`. If either condition is false, call `noop` once with the denied scope and stop without investigating or changing files.

Re-audit the target repository and update `specs/data-acquisition-audit.md` only when its material findings have changed.

## Investigation

1. Read the existing specification before investigating. Treat it as the report to verify, not as authoritative evidence.
2. Search all production JavaScript, shell, editable workflow Markdown, conventional Actions workflows, graders, setup utilities, and cache consumers for:
   - `gh aw logs` and gh-aw commands that obtain overlapping run history;
   - `gh api`, direct GitHub REST or GraphQL clients, GitHub Script calls, and API polling;
   - artifact or file predownloads;
   - indexes, persisted snapshots, in-memory memoization, browser caches, and Actions caches.
3. Inspect JavaScript and embedded JavaScript, including spawned commands and direct `fetch` or Octokit calls. Do not inspect `.github/agents/`.
4. Treat generated `*.lock.yml` files as manifestations of their editable sources. Do not count repeated generated code as an independent acquisition path.
5. Verify call windows, bounds, pagination, concurrency, retry behavior, cache keys, reuse boundaries, fail-closed behavior, and likely core, search, or GraphQL rate-limit pressure from source evidence.
6. Identify overlapping data collection, cold rescans, N+1 requests, polling, incomplete pagination, isolated caches, and repeated work across workflows.

## Update rules

- Preserve the document's scope, inventory, duplicate-work analysis, prioritized bottlenecks, cache-safety constraints, and staged recommendations.
- Correct stale paths, claims, counts, priorities, or omissions using current repository evidence.
- Set the audit date to the current UTC date when making a material update.
- Keep the report concise and evidence-based. Do not speculate about runtime request counts when source code cannot establish them.
- Do not change runtime code, workflow files, generated locks, policy, documentation outside this specification, or credentials.
- Never print or copy secret values while investigating.

Review the final diff and run `git diff --check`. If the audit remains materially accurate, call `noop` with a short reason and do not create a pull request. Otherwise, call `create_pull_request` exactly once with a concise draft PR describing the changed findings and validation. Include a `### Control Plane` section with correlation ID `${{ inputs.correlation_id }}`, central repository `${{ inputs.central_repo }}`, and control plane run `${{ inputs.control_plane_run_url }}`.

Provide only the unprefixed subject as the safe-output title. The configured `title-prefix` is added automatically; do not repeat it or add a semantically equivalent category prefix.
