---
description: Reviews ready pull requests with pinned Matt Pocock engineering skills and repository-specific change context.
engine:
  id: copilot
  max-continuations: 6
max-ai-credits: 500
name: Matt Pocock Skills Reviewer
"on":
  reaction: none
  slash_command:
    events:
    - pull_request_comment
    - pull_request_review_comment
    name: matt
    strategy: centralized
permissions:
  contents: read
  copilot-requests: write
  pull-requests: read
private: true
safe-outputs:
  create-pull-request-review-comment:
    max: 10
  noop: null
  submit-pull-request-review:
    max: 1
skills:
- mattpocock/skills/diagnosing-bugs@3cca18b368ae95cdbdebbff572ccafa662551015
- mattpocock/skills/tdd@3cca18b368ae95cdbdebbff572ccafa662551015
- mattpocock/skills/improve-codebase-architecture@3cca18b368ae95cdbdebbff572ccafa662551015
- mattpocock/skills/grill-with-docs@3cca18b368ae95cdbdebbff572ccafa662551015
- mattpocock/skills/codebase-design@3cca18b368ae95cdbdebbff572ccafa662551015
steps:
- env:
    GH_TOKEN: ${{ github.token }}
    PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || fromJSON(github.event.inputs.aw_context || '{}').item_number }}
    REPOSITORY: ${{ github.repository }}
  name: Prefetch bounded pull request context
  run: "set -euo pipefail\nmkdir -p /tmp/gh-aw/agent\ngh pr view \"$PR_NUMBER\" \\\n  --repo \"$REPOSITORY\" \\\n  --json number,title,body,headRefName,headRefOid,additions,deletions,changedFiles,files \\\n  > /tmp/gh-aw/agent/pr-meta.json\nif gh pr diff \"$PR_NUMBER\" --repo \"$REPOSITORY\" > /tmp/gh-aw/agent/pr-diff.raw; then\n  awk '\n      /^diff --git / {\n        excluded = ($0 ~ /\\.lock\\.yml/ || $0 ~ /\\/dist\\// || $0 ~ /\\/build\\//)\n      }\n      !excluded && emitted < 3000 { print; emitted++ }\n    ' \\\n    /tmp/gh-aw/agent/pr-diff.raw \\\n    > /tmp/gh-aw/agent/pr-diff.patch\nelse\n  printf '# Pull request diff could not be prefetched.\\n' > /tmp/gh-aw/agent/pr-diff.patch\nfi\nrm -f /tmp/gh-aw/agent/pr-diff.raw\nif ! gh api --paginate \"repos/$REPOSITORY/pulls/$PR_NUMBER/comments?per_page=100\" \\\n    --jq '.[] | {id, path, line: (.line // .original_line), body: .body[:300], user: .user.login}' \\\n    | jq -s '.' \\\n    > /tmp/gh-aw/agent/pr-review-comments.json; then\n  printf '[]\\n' > /tmp/gh-aw/agent/pr-review-comments.json\nfi\n"
strict: true
timeout-minutes: 20
tools:
  bash: true
  github:
    min-integrity: approved
    mode: gh-proxy
    toolsets:
    - pull_requests
    - repos
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