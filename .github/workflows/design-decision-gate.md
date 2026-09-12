---
private: true
name: Design Decision Gate
description: Checks significant CAO pull requests for a complete architecture decision record and drafts one when the decision is inferable.
on:
  slash_command:
    strategy: centralized
    name: design-gate
    events: [pull_request_comment, pull_request_review_comment]
  reaction: none
permissions:
  contents: read
  pull-requests: read
  copilot-requests: write
strict: true
max-ai-credits: 500
max-daily-ai-credits: -1
timeout-minutes: 20
concurrency:
  group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || fromJSON(github.event.inputs.aw_context || '{}').item_number || github.run_id }}"
  cancel-in-progress: true
  job-discriminator: "${{ github.run_id }}"
tools:
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [pull_requests, repos]
  bash: true
  edit:
safe-outputs:
  add-comment:
    max: 1
    hide-older-comments: true
  push-to-pull-request-branch:
    allowed-files:
      - "adr/**"
    if-no-changes: ignore
    commit-title-suffix: " [design-decision-gate]"
  noop:
    report-as-issue: false
steps:
  - name: Prefetch decision gate context
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || fromJSON(github.event.inputs.aw_context || '{}').item_number }}
      REPOSITORY: ${{ github.repository }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh pr view "$PR_NUMBER" \
        --repo "$REPOSITORY" \
        --json number,title,body,labels,baseRefName,headRefName,author,url \
        > /tmp/gh-aw/agent/pr.json
      gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER/files?per_page=100" \
        --jq '.[]' | jq -s '.' \
        > /tmp/gh-aw/agent/pr-files.json
      FILE_COUNT="$(jq 'length' /tmp/gh-aw/agent/pr-files.json)"
      if [ "$FILE_COUNT" -le 300 ]; then
        gh pr diff "$PR_NUMBER" --repo "$REPOSITORY" > /tmp/gh-aw/agent/pr.diff
        DIFF_AVAILABLE=true
      else
        printf '# Diff omitted because the pull request exceeds 300 files.\n' > /tmp/gh-aw/agent/pr.diff
        DIFF_AVAILABLE=false
      fi
      CORE_ADDITIONS="$(jq '[
        .[]
        | select(.filename | test("^(.github/cao/src|activity|dashboard/report|dashboard/site/src|scripts)/"))
        | .additions
      ] | add // 0' /tmp/gh-aw/agent/pr-files.json)"
      HAS_IMPLEMENTATION_LABEL="$(jq '[.labels[]?.name] | index("implementation") != null' /tmp/gh-aw/agent/pr.json)"
      jq -n \
        --argjson additions "$CORE_ADDITIONS" \
        --argjson implementation "$HAS_IMPLEMENTATION_LABEL" \
        --argjson file_count "$FILE_COUNT" \
        --argjson diff_available "$DIFF_AVAILABLE" \
        '{
          core_additions: $additions,
          has_implementation_label: $implementation,
          file_count: $file_count,
          diff_available: $diff_available,
          requires_adr: ($implementation or $additions > 100)
        }' \
        > /tmp/gh-aw/agent/decision-gate-summary.json
---

# Design Decision Gate

Ensure that significant changes have an explicit Architecture Decision Record (ADR) before merge.

## Gate process

1. Read `/tmp/gh-aw/agent/decision-gate-summary.json`.
2. If `requires_adr` is false, call `noop` with the measured core additions and stop.
3. Read the pre-fetched `pr.json`, `pr-files.json`, and `pr.diff`. When `diff_available` is false, use file metadata only and do not fetch the oversized diff.
4. Search the pull request body, changed files, and existing `adr/*.md` files for an ADR. Read only likely records identified by title, pull request number, or links.
5. A complete ADR must contain `Context`, `Decision`, `Alternatives Considered`, and `Consequences`.
6. If a complete ADR exists, compare it with the implementation:
   - comment once that it aligns, or
   - comment once with specific divergences and the required correction.
7. If no complete ADR exists, invoke the `adr-writer` agent with only the pre-fetched evidence.
8. If the agent can infer one concrete architectural decision, zero-pad the pull request number to four digits and create `adr/{NNNN}-{kebab-case-title}.md`, then use `push-to-pull-request-branch` and post one comment linking the draft.
9. If the decision is not inferable, post one comment listing the missing decision context. Do not invent rationale or alternatives.
10. Stop immediately after the safe output. Never modify files outside `adr/`.

All evidence and conclusions must remain scoped to this repository and pull request.

## agent: `adr-writer`
---
description: Produces one evidence-grounded Michael Nygard architecture decision record from pre-fetched pull request context.
model: claude-sonnet-5
---

Read only the supplied pull request metadata, changed-file metadata, and bounded diff.

Return a draft ADR only when the evidence supports a single concrete architectural decision. Use this structure:

1. `# ADR {PR_NUMBER}: {Decision title}`
2. `## Status` with `Draft`
3. `## Context`
4. `## Decision`
5. `## Alternatives Considered`
6. `## Consequences`, including positive and negative consequences

Requirements:

- Ground every claim in the pull request evidence.
- Describe two realistic alternatives only when the evidence supports them.
- Mark missing context as `Not inferable from current pull request evidence`.
- Do not invent stakeholder intent, constraints, rejected technologies, or performance claims.
- Return JSON only:
  - success: `{"status":"draft","filename":"adr/NNNN-title.md","content":"..."}`;
  - insufficient evidence: `{"status":"insufficient_evidence","missing":["..."]}`.
