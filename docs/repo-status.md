---
title: Daily Repo Status
description: Install an on-demand, CAO-governed adaptation of Agentics Daily Repo Status.
---

Daily Repo Status summarizes recent repository activity, celebrates progress,
and proposes actionable next steps. CAO publishes **`repo-status-cao`**, a
standalone adaptation of [Agentics Daily Repo Status](https://github.com/githubnext/agentics/blob/main/docs/repo-status.md).
It needs no campaign, orchestrator, or worker dispatch.

This variant is **opt-in, manual-only, disabled by default, and review-only**.
The root CAO installation does not install it automatically. Review mode runs
the agent and creates a report issue in a validated review repository; it is
not a no-write simulation. This variant cannot deliver directly to the target.

## Install on demand

First [set up a CAO control repository](./setup-quickstarts.md), including its
shared runtime, policy, and separate read/write credentials. Choose one exact
repository already enrolled in that policy. Read credentials need repository
contents, Actions, issues, and pull requests; the safe-output credential needs
issue-write access to the review repository. Keep credentials in Actions secrets.

From the control repository, install the maintained CAO variant:

```sh
gh aw add githubnext/gh-cao/.github/workflows/repo-status-cao.md@main
```

The explicit source path is intentional; the shorthand workflow lookup searches
`workflows/`, not `.github/workflows/`. Pin `@main` to a reviewed commit SHA for
a reproducible installation. This source becomes available when the change
publishing it is merged.

Installation does not grant CAO authority. Add this exact entry to
`control-plane.workflows` in `.github/workflows/cao.json`, preserving existing
scope and declarations:

```json
{
  "repo-status-cao": {
    "enabled": false,
    "mode": "review",
    "max-mode": "review",
    "max-repositories": 1
  }
}
```

An undeclared or disabled workflow is denied before agent execution. Review the
installed source and generated lock, validate policy, and compile with the
policy-pinned `gh aw`. Commit workflow, lock, and policy together.

## Authorize a manual review run

Separately review a policy change setting this entry's `enabled` to `true`;
leave both mode fields at `review` and the repository cap at one. This is an
explicit activation decision, not part of installation.

Once that reviewed revision is on the control repository's default branch:

```sh
gh aw run repo-status-cao \
  --raw-field target_repo=acme/service \
  --raw-field safe_output_repo=acme/review \
  --raw-field safe_output_mode=review
```

Replace the example repositories with your enrolled target and accessible
review repository. The review destination must differ from the target; a
non-control review repository must be private. Omit `safe_output_repo` to use
the control repository, provided it is not also the target.

Shared control resolves policy at the exact workflow revision, checks scope,
and validates the destination before the agent runs. The workflow requests
review mode even if policy is later widened. It examines only the one admitted
target and publishes at most one `[repo-status-cao]` issue. Labels and closure
of older reports stay in the review repository; a target-specific close key
prevents one repository's report from closing another's.
Stable target-and-date titles are deduplicated. Reports do not expire
automatically: this avoids adding a scheduled expiration-maintenance workflow;
older reports are closed when a new report for the same target is published.

The report covers the last 24 hours and includes evidence limitations.
Discussions and organization-level project data are not assessed by this
narrower read-tool configuration. No meaningful activity produces a no-op;
missing core evidence is reported as incomplete instead of a misleading issue.
Diagnostic issue creation is disabled; incomplete runs remain visible in
Actions results and summaries. Mentions and GitHub references are escaped so a
review report does not notify users or add timeline references in the target.

Compilation and contract tests do not prove that credentials work or an agent
will produce a useful report. A live review run is a separate authorized check:
confirm the review issue was created and the target was not modified.

## Provenance, updates, and scheduling

The source adaptation is based on
[`githubnext/agentics/workflows/repo-status.md` at `b4e175bab6674279e0fe158f7dc877b77bc9d92f`](https://github.com/githubnext/agentics/blob/b4e175bab6674279e0fe158f7dc877b77bc9d92f/workflows/repo-status.md).
The upstream `daily-repo-status.md` redirects to that source. Its MIT notice is
preserved in the CAO variant.

CAO maintainers reconcile upstream changes manually. `gh aw update` of the
CAO-installed variant tracks this catalog source, not an automatic merge from
Agentics. An independently installed upstream `repo-status` and its ownership
metadata remain unchanged.

Unlike upstream, the variant has no daily schedule, uses standalone admission
and target-scoped read authentication, and routes reports and older-report
closure exclusively to review. It retains the report mission and Copilot
engine while narrowing GitHub tools and fixing the issue cap at one. It does
not inherit upstream's unrestricted read-tool configuration.

Do not run both versions on the same daily mission. Before adding a schedule,
review trigger inputs (scheduled events have no manual `target_repo`), establish
an explicit scheduled target and review request, recompile, and coordinate
cutover from the upstream schedule. Neither installation nor this guide
disables the upstream workflow or activates a schedule.
