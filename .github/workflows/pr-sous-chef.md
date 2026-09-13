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
max-turns: 5
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
  add-comment:
    max: 4
    target: "*"
  mentions:
    allowed: ["@copilot"]
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
5. For each selected pull request, check only whether a comment containing `<!-- cao-pr-sous-chef-nudge -->` was posted in the last 30 minutes. Skip it when one exists.
6. Post one combined comment per selected pull request, stopping after four comments. It must begin with `<!-- cao-pr-sous-chef-nudge -->`, mention `@copilot`, identify the blocker visible in the queue metadata, and ask Copilot to invoke the repository's `pr-finisher` skill.
7. Do not inspect code, check logs, review threads, or branch contents.
8. Do not wait, poll, fix, validate, commit, or push.
9. If nothing is dispatched, call `noop` with concise counts for evaluated, pending, recently dispatched, and no-clear-blocker pull requests.

Never target another repository. Never use raw GitHub writes; all comments must use the declared safe output.
