---
title: Release change controls
description: Configure independent review and applicable CI gates without claiming certification or operating evidence.
---

These repository-supported controls address release evidence and change review
(SOC 2 CC7.1 and CC8.1). They are control design, not SOC 2 certification or proof
that a control operated over an audit period. They do not enable hosted CLI
execution, change CAO rollout policy, or grant authority over enrolled targets.

## GitHub-native configuration

`.github/rulesets/release-controls.json` is a native GitHub REST ruleset payload,
not a new CAO policy schema. It proposes protection of the default branch with:

- one approving review, CODEOWNERS review, stale-review dismissal, approval of
  the latest push by someone other than its pusher, and resolved review threads;
- the three required GitHub Actions checks below, against the latest base branch;
- CodeQL merge protection for error alerts and high-or-higher security alerts;
- no bypass actors, deletion, or force pushes.

The existing `.github/CODEOWNERS` assigns `@github/next`. An administrator must
verify that this team has suitable write access and independent reviewers.
An automated review or an author's self-review does not supply independent approval.

| Required check context | Applicable producers |
| --- | --- |
| `Contracts gate` | `Unit contracts (activity/dashboard/workflows/tooling/documentation)`, `test` (lint, typechecks, seeded compile), and `Install agent plugin with Copilot CLI` |
| `Dashboard gate` | `Lint and unit tests` (dashboard types, lint, unit tests, build) |
| `Server gate` | `Go format, lint, and tests` and `TypeSpec API contract and generated artifacts` |

These are exact job check names, not workflow display names. The payload pins
their producer to the GitHub Actions integration ID `15368`, verified against
this repository's check-run API. Revalidate that ID before adapting to another host.
Do **not** require path-filtered producers or main-only browser, performance,
integration, campaign, or reporting jobs directly.

The three workflows now start on every pull request. A shared selector moves
their existing PR path rules to the job boundary. It reads the complete,
NUL-delimited synthetic merge diff, including both sides of renames, rather
than GitHub's capped path-filter file list. Changes to the shared selector run
all three scopes. Each summary runs with `always()` and fails if selection
fails, an applicable producer fails/cancels/skips, or a required result is absent.
Only a successful selector proving no applicable changes permits skipped
producers. Main-push coverage and main-only expensive jobs retain their triggers.

CodeQL uses the native `code_scanning` rule, not an `Analyze (go)` status:
successful analysis alone does not mean no high-severity findings. CodeQL must
remain configured and results must be available for the relevant revision.
GitHub's native applicability rules avoid inventing a required analysis-job
context for documentation-only changes. Native merge protection has
[documented exceptions](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection)
for merge queues and Dependabot PRs analyzed by default setup; those release
paths need a separate reviewed scanner disposition, not an assumed pass.
This change does not enable merge queues.

## Administrator rollout (not performed by the code change)

1. Land the CI gate implementation through an independently reviewed PR. Before
   activating required checks, confirm that all three exact check contexts are
   emitted for representative dashboard-only, server-only, docs-only, and mixed
   PRs on the current SHA. Rerun or update older open PRs that predate the gates.
2. Confirm CodeQL default setup is configured, inspect its current findings, and
   retain the scanner result links and dispositions. Test native scanner
   applicability on the documentation-only PR as well.
3. Export the live `main` ruleset (`20054276`) and any inherited rules. In
   Settings > Rules > Rulesets, strengthen that ruleset using the reviewed
   payload as the field-level reference. Preserve its existing deletion and
   force-push prohibitions and any stronger rules; do not replace inherited
   policy or add bypass actors. Activate the review, three status-check, and
   CodeQL rules only after step 1. Native REST create/update is an admin action,
   not a capability of the verifier.
4. Run the read-only verification below with a credential permitted to see
   bypass actors. Inspect effective branch rules as well: the verifier checks
   the specified ruleset, not all inherited rules or historical review activity.
   Unknown additional required checks fail verification for manual inspection
   rather than being assumed safe from path-filter deadlocks.

```sh
node scripts/verify-release-ruleset.mjs githubnext/gh-aw-cao 20054276
gh api --method GET repos/githubnext/gh-aw-cao/rules/branches/main
```

The app's supported `.github/github-app.yml` exposes the same verification as a
manual script, with no automatic triggers or settings writes. It uses only GET,
prints timestamped findings, and exits nonzero on missing, inaccessible, or
weakened protection. If administrators instead create a separate additive
ruleset, pass its actual ID and update the manual script in a reviewed change.
Retain before/after exports, approving identities, exact SHAs, CI links,
scanner dispositions, and deployment authorization in the approved evidence
system. Never commit credentials or raw secret-bearing logs.

## Hosted CLI finding disposition

At parent PR [#18462](https://github.com/githubnext/gh-aw-cao/pull/18462), revision
`81b7333a7cbb4cc5064ccb3f2c7d9dd22196d132`,
[CodeQL check 117485353748](https://github.com/githubnext/gh-aw-cao/runs/117485353748)
reported a high-severity potential allocation overflow in
`server/internal/hostedcli/apple_container.go`: `42 + len(spec.Args)`.
This is scanner evidence, not independently established exploitation.
The fix constructs the fixed argument prefix as a slice literal and appends
the variable arguments, removing the arithmetic from allocation sizing without
suppressing the query or changing runtime authority. Regression coverage checks
empty, single, and many arguments, preserving order and literal boundaries.
Closure requires a fresh CodeQL result on the fix/integrated SHA; a local Go
test is not scanner clearance.

The same parent revision's dashboard failures were stale contract tests: native
`gh aw update` and explicit `cao-repository` context are intentional. Updated
tests require the exact upstream package/control-repository command prefix,
fail closed when host context is missing, and preserve explicit PR creation and
opt-in auto-merge. No production dashboard command or rollout scope changed.
