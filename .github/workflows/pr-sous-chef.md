---
private: true
name: PR Sous Chef
description: Rapidly triages open pull requests and dispatches clear blockers to Copilot.
engine: copilot
model: copilot/mai-code-1.1-flash
on:
  schedule: every 30m
  workflow_dispatch:
  slash_command:
    strategy: centralized
    name: souschef
    events: [pull_request_comment]
  skip-if-no-match: "is:pr is:open -is:draft"
permissions:
  actions: read
  issues: read
  pull-requests: read
  copilot-requests: write
strict: true
max-ai-credits: 25
max-daily-ai-credits: -1
timeout-minutes: 5
concurrency:
  group: "${{ github.workflow }}-${{ github.event_name == 'schedule' && github.repository || fromJSON(github.event.inputs.aw_context || '{}').item_number || github.run_id }}"
  cancel-in-progress: true
tools:
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [pull_requests]
network:
  allowed:
    - defaults
safe-outputs:
  assign-to-agent:
    name: copilot
    allowed: [copilot]
    max: 4
    target: "*"
    custom-instructions: Resolve the actionable blockers already visible on this pull request with the smallest complete change and appropriate validation.
  noop:
    report-as-issue: false
steps:
  - name: Build bounded pull request queue
    env:
      GH_TOKEN: ${{ github.token }}
      REPOSITORY: ${{ github.repository }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      if ! gh pr list \
          --repo "$REPOSITORY" \
          --state open \
          --search "is:pr is:open -is:draft sort:updated-asc" \
          --limit 10 \
          --json number,title,url,headRefOid,updatedAt,mergeStateStatus,statusCheckRollup \
          > /tmp/gh-aw/agent/pr-sous-chef-queue.json; then
        printf '[]\n' > /tmp/gh-aw/agent/pr-sous-chef-queue.json
      fi
---

# PR Sous Chef

Rapidly scan open pull request metadata and dispatch at most four pull requests with clear blockers to Copilot. You are only a dispatcher.

## Required process

1. Read `/tmp/gh-aw/agent/pr-sous-chef-queue.json`.
2. For a `/souschef` invocation, consider only the pull request that received the command and dispatch it once.
3. Otherwise, scan the queue once in its existing order. Use only each entry's title, `mergeStateStatus`, and `statusCheckRollup`.
4. Dispatch a pull request only when that metadata clearly shows merge conflicts or a completed failed check. Skip queued or in-progress checks.
5. Call `assign_to_agent` once for each selected pull request, stopping after four assignments.
6. Do not inspect code, check logs, review threads, or branch contents.
7. Do not wait, poll, fix, validate, commit, or push.
8. If nothing is dispatched, call `noop` with concise counts for evaluated, pending, and no-clear-blocker pull requests.

Never target another repository. Never use raw GitHub writes; all assignments must use the declared safe output.
