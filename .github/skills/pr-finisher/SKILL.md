---
name: pr-finisher
description: Prepare the current branch's pull request for human merge by addressing reviews, validating CAO changes, and checking mergeability. Never merges.
---

# PR Finisher

Prepare the open pull request for the current branch for human merge. Work autonomously, make the smallest relevant fixes, and never merge or enable auto-merge.

## Completion gates

Work on these gates concurrently:

1. **Reviews** — address every actionable unresolved review thread from trusted reviewers and automation. A code change is incomplete until the existing thread has a substantive reply and is resolved.
2. **Validation** — run the narrowest repository commands that fully cover the changed files, then fix failures caused by the pull request.
3. **Mergeability** — confirm the pull request is open, inspect draft and merge state, and resolve conflicts or an out-of-date branch when repository policy requires it.

Top-level comments and review summaries are useful input, but unresolved review threads are the review gate.

## Repository validation

Choose validation from the changed paths:

| Changed area | Required validation |
|---|---|
| `.github/workflows/shared/*.mjs` | `npm run typecheck:cao && npm test` |
| `dashboard/site/` | From `dashboard/site/`: `npm test && npm run test:e2e && npm run lint && npm run typecheck` |
| `.github/workflows/*.md` | `npm run compile`; use `npm run compile:locks` only when lock files must be regenerated |
| SVG files | `npm run check:svg` |
| `docs/` | `npm run docs:build` |
| Multiple or uncertain areas | `npm run check` |

Never edit `.github/workflows/*.lock.yml` directly. Resolve source changes in the Markdown workflow and regenerate locks with `npm run compile:locks`, which applies the repository's deterministic schedule seed.

## Workflow

1. Read the pull request once and retain a local snapshot of its state, reviews, review threads, checks, head SHA, and mergeability. Paginate bounded reads instead of requesting an unbounded response.
2. If the pull request is closed or merged, report that state and stop.
3. Inspect the latest GitHub Actions runs and fetch logs for every failed job. Treat checks from an older head SHA as stale.
4. Address actionable unresolved review threads:
   - verify each finding against the current code;
   - apply only valid fixes;
   - run the affected validation;
   - reply to the existing review comment with the result;
   - resolve the thread when the concern is satisfied.
5. Resolve merge conflicts using editable sources first. For workflow lock conflicts, run `npm run compile:locks` and stage the regenerated files.
6. Run the required validation for all changed paths. Do not weaken tests, checks, permissions, or policy to hide a failure.
7. Before every commit, scan all changed files for secrets. Never log or commit secret values.
8. Commit and push each validated iteration with the provided progress-reporting tool. Do not use `git push` or `gh` to update the pull request.
9. Request a code review, address valid findings, then run CodeQL. Re-run either check after a significant fix.
10. Refresh pull request state only after an action that can invalidate the snapshot. Do not wait or poll for CI after an agent push.

Use the provided GitHub MCP Actions tools to list workflow runs and read failed-job logs. Do not claim CI logs are unavailable without attempting those tools.

## Hard rules

- Never merge, enable auto-merge, or enqueue the pull request.
- Never post a stand-alone status comment; reply only where an existing review thread requires it.
- Never ask for confirmation when the next safe action is clear.
- Never use sleep, watch, or polling loops.
- Never modify unrelated files or guess-fix a pre-existing failure.
- Treat missing credentials, policy, authority, or evidence as a fail-closed hand-off.

## Final report

Report each gate in plain language:

- Reviews — resolved, or list the remaining human-owned blocker.
- Validation — commands run and their results.
- CI — current, stale after the agent push, or unavailable with the attempted lookup.
- Mergeability — clean, conflicting, behind, or draft.
- Actions taken — files or review threads changed.
- Hand-off — the exact human action still required before merge.

Stop when all agent-actionable work is complete. The final state is ready for **human** merge, never merged by the agent.
