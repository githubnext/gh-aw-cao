---
private: true
name: PR Sous Chef
description: Fixes actionable blockers on open pull requests and pushes validated changes to their branches.
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
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
checkout:
  fetch-depth: 0
  fetch: ["*"]
strict: true
max-ai-credits: 300
max-daily-ai-credits: -1
timeout-minutes: 15
concurrency:
  group: "${{ github.workflow }}-${{ github.event_name == 'schedule' && github.repository || fromJSON(github.event.inputs.aw_context || '{}').item_number || github.run_id }}"
  cancel-in-progress: true
tools:
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [pull_requests, repos, actions]
  bash:
    - "*"
  edit:
  playwright:
    version: "0.1.18"
    browsers: [chrome, chromium]
network:
  allowed:
    - defaults
    - node
    - chrome
    - playwright
safe-outputs:
  add-comment:
    max: 4
    target: "*"
  push-to-pull-request-branch:
    target: "*"
    max: 4
    allowed-files:
      - "**"
    protected-files: allowed
    if-no-changes: ignore
  noop:
    report-as-issue: false
steps:
  - name: Setup Node.js
    uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020  # v7.0.0
    with:
      node-version: 24
      cache: npm
  - name: Install development dependencies
    run: npm ci
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
          --limit 50 \
          --json number,title,url,headRefOid,updatedAt,mergeStateStatus,statusCheckRollup \
          > /tmp/gh-aw/agent/pr-sous-chef-queue.json; then
        printf '[]\n' > /tmp/gh-aw/agent/pr-sous-chef-queue.json
      fi
---

# PR Sous Chef

Move open pull requests toward merge by fixing actionable code blockers and pushing validated commits to at most four pull request branches.

## Required process

1. Read `/tmp/gh-aw/agent/pr-sous-chef-queue.json`.
2. For a `/souschef` invocation, inspect only the pull request that received the command.
3. Otherwise, inspect the oldest updated candidates first and select at most four that have an actionable blocker:
   - merge conflicts;
   - completed failed checks;
   - unresolved review feedback;
   - an out-of-date branch when current policy requires it.
4. Skip pull requests with a queued or in-progress check less than one hour old.
5. Use bounded, paginated reads. Fetch detailed checks or review threads only for a candidate likely to receive a fix.
6. For each selected pull request:
   - check out its head branch and invoke the repository's `pr-finisher` skill;
   - diagnose the blocker from repository evidence, implement the smallest complete fix, and update tests when needed;
   - use the preinstalled development tools and run the narrowest relevant validation;
   - use `playwright-cli open --browser=chromium` when browser investigation is needed; this selects Chrome for Testing, while the repository Playwright installation provides Chromium for test execution;
   - review the final diff, commit the validated changes, and call `push_to_pull_request_branch` with the pull request number;
   - if and only if the pushed commit modifies one or more `.lock.yml` files, call `add_comment` on that pull request with `<!-- cao-pr-sous-chef-lock-change -->` followed by an agentic description of why each generated lock file changed and which editable workflow source produced it.
7. Never edit a `.lock.yml` file directly. Change the corresponding workflow Markdown source and regenerate locks with the repository's compile command.
8. Break ties by lower pull request number so repeated runs are deterministic.
9. If no candidate needs a code change, call `noop` with concise counts for evaluated, pending, blocked-but-not-fixable, and ready pull requests.

Never target another repository. Never use raw GitHub writes; all branch pushes and comments must use their declared safe outputs.
