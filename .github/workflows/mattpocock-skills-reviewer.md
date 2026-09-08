---
private: true
name: Matt Pocock Skills Reviewer
description: Reviews ready pull requests with pinned Matt Pocock engineering skills and repository-specific change context.
on:
  slash_command:
    strategy: centralized
    name: matt
    events: [pull_request_comment, pull_request_review_comment]
  reaction: none
permissions:
  contents: read
  pull-requests: read
  copilot-requests: write
strict: true
max-ai-credits: 500
timeout-minutes: 20
engine:
  id: copilot
  max-continuations: 6
skills:
  - mattpocock/skills/diagnosing-bugs@801dca688564c529fa84f247f64472520d9ebe28
  - mattpocock/skills/tdd@801dca688564c529fa84f247f64472520d9ebe28
  - mattpocock/skills/improve-codebase-architecture@801dca688564c529fa84f247f64472520d9ebe28
  - mattpocock/skills/grill-with-docs@801dca688564c529fa84f247f64472520d9ebe28
  - mattpocock/skills/codebase-design@801dca688564c529fa84f247f64472520d9ebe28
tools:
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [pull_requests, repos]
  bash: true
safe-outputs:
  create-pull-request-review-comment:
    max: 10
  submit-pull-request-review:
    max: 1
  noop:
steps:
  - name: Prefetch bounded pull request context
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || fromJSON(github.event.inputs.aw_context || '{}').item_number }}
      REPOSITORY: ${{ github.repository }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/agent
      gh pr view "$PR_NUMBER" \
        --repo "$REPOSITORY" \
        --json number,title,body,headRefName,headRefOid,additions,deletions,changedFiles,files \
        > /tmp/gh-aw/agent/pr-meta.json
      if gh pr diff "$PR_NUMBER" --repo "$REPOSITORY" > /tmp/gh-aw/agent/pr-diff.raw; then
        awk '
            /^diff --git / {
              excluded = ($0 ~ /\.lock\.yml/ || $0 ~ /\/dist\// || $0 ~ /\/build\//)
            }
            !excluded && emitted < 3000 { print; emitted++ }
          ' \
          /tmp/gh-aw/agent/pr-diff.raw \
          > /tmp/gh-aw/agent/pr-diff.patch
      else
        printf '# Pull request diff could not be prefetched.\n' > /tmp/gh-aw/agent/pr-diff.patch
      fi
      rm -f /tmp/gh-aw/agent/pr-diff.raw
      if ! gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER/comments?per_page=100" \
          --jq '.[] | {id, path, line: (.line // .original_line), body: .body[:300], user: .user.login}' \
          | jq -s '.' \
          > /tmp/gh-aw/agent/pr-review-comments.json; then
        printf '[]\n' > /tmp/gh-aw/agent/pr-review-comments.json
      fi
---

# Matt Pocock Skills Reviewer

Review the pull request's changed lines with the smallest relevant set of the installed Matt Pocock engineering skills.

## Process

1. Read these pre-fetched files before using any GitHub tool:
   - `/tmp/gh-aw/agent/pr-meta.json`
   - `/tmp/gh-aw/agent/pr-diff.patch`
   - `/tmp/gh-aw/agent/pr-review-comments.json`
2. Discover available `SKILL.md` files under the engine's installed skill locations. Read only the one or two skills relevant to the change.
3. Classify the change and choose skills:
   - bug fix: `diagnosing-bugs` and `tdd`;
   - feature: `tdd` and `grill-with-docs`;
   - refactor or architecture: `codebase-design` and `improve-codebase-architecture`;
   - documentation or workflow intent: `grill-with-docs`;
   - mixed: `codebase-design` and `tdd`.
4. Apply this repository's contracts while reviewing:
   - `.github/workflows/*.lock.yml` files are generated and must not be reviewed as source;
   - workflow behavior comes from the matching Markdown source;
  - CAO authority, gh-aw execution authority, and credentials must remain separate; target files must not alter CAO activation authority;
   - missing policy or evidence must fail closed;
   - changes spanning multiple areas should remain navigable and use existing domain language.
5. Review changed lines only. Prioritize security, correctness, authority boundaries, tests, then maintainability. Do not comment on formatting or subjective style.
6. Check `/tmp/gh-aw/agent/pr-review-comments.json` before emitting a finding. Do not duplicate an existing finding.
7. Create at most ten inline comments. Prefix each with the applied skill, explain the concrete risk, and state the smallest corrective action.
8. Submit exactly one overall review:
   - `REQUEST_CHANGES` for correctness, security, or authority-boundary defects;
   - `COMMENT` for non-blocking actionable observations;
   - `APPROVE` only when no actionable defect remains.
9. If the context cannot support a review, call `noop` with the specific missing evidence. Otherwise, approve a pull request with no actionable defect instead of posting generic praise.

Do not fetch the full diff again. If the 3000-line prefetch is insufficient, state the review limitation instead of making unsupported claims.
