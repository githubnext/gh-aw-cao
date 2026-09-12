---
description: "Reviews pull requests that change workflow contracts by compiling and validating all agentic workflow validators."
name: "Workflow PR Validator"
on:
  pull_request:
    types: [ready_for_review]
    paths:
      - ".github/workflows/*.md"
  workflow_dispatch:
max-ai-credits: 350
max-daily-ai-credits: -1
timeout-minutes: 45
run-name: "PR workflow review · #${{ github.event.pull_request.number || github.run_number }}"
concurrency:
  group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: read
  actions: read
  copilot-requests: write
strict: true
tools:
  github:
    mode: remote
    min-integrity: approved
    toolsets: [pull_requests, repos]
  agentic-workflows: true
  cli-proxy: true
network:
  allowed:
    - defaults
    - github
    - node
steps:
  - name: Checkout repository
    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
    with:
      persist-credentials: false
  - name: Setup Node.js
    uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020  # v7.0.0
    with:
      node-version: 24
      cache: npm
  - name: Install dependencies
    run: npm ci
  - name: Run all validator commands
    shell: bash
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent/pr-reviewer
      SUMMARY=/tmp/gh-aw/agent/pr-reviewer/validator-summary.json

      run_cmd() {
        local name="$1"
        shift
        local log_file="/tmp/gh-aw/agent/pr-reviewer/${name}.log"
        set +e
        "$@" >"$log_file" 2>&1
        local status=$?
        set -e
        jq --arg name "$name" --arg log "$log_file" --argjson status "$status" \
          '.checks += [{name: $name, status: $status, log: $log}]' \
          "$SUMMARY" > "${SUMMARY}.tmp"
        mv "${SUMMARY}.tmp" "$SUMMARY"
      }

      printf '{"checks":[]}\n' > "$SUMMARY"
      run_cmd test_unit npm run test:unit
      run_cmd test_integration npm run test:integration
      run_cmd test_load npm run test:load
      run_cmd docs_build npm run docs:build

      jq '
        .failed = ([.checks[] | select(.status != 0)] | length) |
        .passed = ([.checks[] | select(.status == 0)] | length)
      ' "$SUMMARY" > "${SUMMARY}.tmp"
      mv "${SUMMARY}.tmp" "$SUMMARY"
safe-outputs:
  create-pull-request-review-comment:
    max: 20
  submit-pull-request-review:
    max: 1
    allowed-events: [COMMENT, REQUEST_CHANGES]
---

# Workflow PR Validator

Review this pull request as a workflow-validator reviewer.

## Required execution policy

1. Read `/tmp/gh-aw/agent/pr-reviewer/validator-summary.json`.
2. Confirm every listed validator command ran.
3. For each failed command, read the paired log file and extract concrete failing checks or stack traces.
4. Run the `compile` tool (via the `agentic-workflows` CLI proxy, e.g. `agentic-workflows compile`) to validate that all agentic workflows still compile; treat a non-zero result as a failed `compile_validate` check and capture its output for review comments.
5. Parse the `compile` output for compiler warnings or errors and add line-level pull-request review comments when the output includes a path and line that can be mapped to files in this pull request.
6. Submit exactly one pull request review:
   - Use `REQUEST_CHANGES` if any validator failed.
   - Use `COMMENT` if all validators passed.

## Validation contract

Treat these commands as the full validator contract for this repository:

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:load`
- `agentic-workflows compile` (CLI-proxy equivalent of `gh aw compile`)
- `npm run docs:build`

## Review output rules

- Keep the review concise and factual.
- Report each validator status (`pass`/`fail`) in a checklist.
- For failures, include only actionable details from logs.
- Use `create-pull-request-review-comment` for compiler warnings/errors from the `compile` output when a concrete file and line are available.
- Do not create duplicate review comments for the same finding.
- Do not approve the pull request.
- Do not use emoji in error text.
