# Repo Status

Understand yesterday's repository progress and the next useful action, across
an explicitly enrolled fleet. Repo Status turns bounded GitHub activity into
one concise report per target, starting in your control repository for review.

> [!NOTE]
> Experimental. Reports are advisory summaries, not project health grades or
> proof that a recommended action was accepted.

## Campaign contents

| Workflow | Responsibility |
| --- | --- |
| [`repo-status`](../.github/workflows/repo-status.md) | Rank admitted repositories and dispatch the reporting worker; hourly schedule and manual dispatch. |
| [`repo-status-report`](../.github/workflows/repo-status-report.md) | Independently dispatchable worker analyzing exactly one repository's previous complete UTC day. |

## Install

Complete [CAO setup](https://githubnext.github.io/gh-cao/setup-quickstarts/) first,
then install from your control checkout:

```bash
gh cao campaigns add githubnext/gh-cao/repo-status
gh cao campaigns mode preview repo-status
```

Use a reviewed catalog revision with `@COMMIT_SHA` when pinning installation.
The root CAO package intentionally does **not** install this optional campaign.
The catalog discovers its manifest automatically. The source-managed policy in
this repository registers it **disabled**, with a review worker ceiling; this
change grants no new target scope or live authority.

## Policy and first run

Follow the [Setup > Quickstart](https://githubnext.github.io/gh-cao/setup/quickstart/)
for publishing, pausing the schedule, and one manual review run. Merge the
following campaign fragment into your existing policy; do not replace the
rest of your setup:

```json
{
  "control-plane": {
    "campaigns": {
      "repo-status": {
        "enabled": false,
        "mode": "review",
        "max-repositories": 1,
        "rollout-percent": 100,
        "targets": {
          "TARGET_OWNER/TARGET_REPOSITORY": { "mode": "review" }
        },
        "workers": {
          "report": {
            "workflow": "repo-status-report",
            "max-mode": "review"
          }
        }
      }
    }
  }
}
```

Replace the target coordinate. Keep exact `allowed-owners` and
`allowed-repositories` for the control repository and target. `targets` narrows
this campaign further; it never enrolls a repository outside global scope.
Publish workflows and policy together. The initial `enabled: false` prevents
an hourly tick from doing agentic work before you pause the orchestrator.

The read credential needs Contents, Issues, Pull requests and Actions **read**
on the target. Review output needs Issues write in the control repository;
dispatch needs Actions write there. Shared control resolves the configured
App or owner-scoped PAT and propagates the worker's exact read permissions.
Public target visibility is not a substitute for verified API access. The
built-in workflow token reads existing review reports in the control repository
without widening the target-read credential. An alternate external review
destination needs readable report history with the configured credential;
otherwise the lookup fails closed. Start with the control repository.
Model access, Actions usage and AI credits are separate prerequisites. The
bundled workflows use Copilot, matching the maintained Repo Assist profile;
configure another supported engine consistently if your control plane uses one.

## Reports and lifecycle

The worker reads issues, PRs, default-branch commits, releases and Actions runs.
Each category is bounded to two pages of 100 items. Counts from a truncated
category are explicitly **observed**, not totals or productivity metrics.
Inaccessible required evidence is incomplete; a fully read quiet day is a
silent no-op. Discussions are deliberately omitted from this worker's
permission contract.

The window is `[00:00 UTC yesterday, 00:00 UTC today)` relative to the worker
run's original creation time, not the time of a rerun. Grouping is by target
and activity type. Work identity is target + effective mode + UTC date.
Hourly selection uses bounded advisory memory to avoid redispatching already
covered days; memory never authorizes or proves completion.

Find the report by both labels, `repo-status` and `repo-status:report`, and the
stable title `[repo-status:report] OWNER/REPO repository status`. Dates and
coverage live in the body. A later day replaces the body of the verified,
workflow-owned report for that target, rather than closing other reports.
An already covered day, including a recently closed report, is a no-op.
Creation is handler-deduplicated by title; updates require both labels.
The worker emits at most one create **or** update per run. Reports expire three
days after creation; body refresh does not extend that deadline.

Review reports stay in the admitted review repository, with non-linking target
item references to avoid target timeline backlinks. Live reporting requires a
separate reviewed policy change, removal of the worker's review ceiling, and
the appropriate target write credential. It still cannot change code or PRs.
Debug is a manual, staged preview, never a live mode.

The orchestrator is capped at 150 AI credits and each worker at 300, plus any
configured gh-aw output-check budget. Default scope is one repository; the
compiled dispatch ceiling is ten. These are limits, not measured consumption.

## Customize, pause and stop

Optional control-owned steering belongs in `.github/cao/repo-status.md`.
Refine priorities or report emphasis there; it cannot change permissions,
enrolled targets, output destinations or the fixed reporting window.
Do not edit installed campaign-owned files just to add local steering.

Keep the orchestrator disabled in Actions after a one-off run. For a persistent
stop, commit `control-plane.campaigns.repo-status.enabled: false` and cancel
already active runs. A worker-only stop uses `workers.report.enabled: false`.
Recurring reporting and wider scope are separate rollout decisions.

## Evaluation

The intended benefit is less maintainer effort understanding progress and
choosing a useful next action. **Operational value is not measurable yet**:
there is no deterministic repository-native acceptance rule proving that
understanding improved or a decision was useful. Report counts, green runs,
body completeness and issue closure/expiration are mechanism or lifecycle
signals, not accepted outcomes. No operational-value evaluator or worker
`evals` is added. Contract tests cover routing, bounds, identity and no-op rules;
they do not establish report quality or usefulness.

## Attribution

Adapted from GitHub's MIT-licensed
[`githubnext/agentics` Repo Status workflow](https://github.com/githubnext/agentics/blob/ae8d551f07c7ed7619f8c58c7bb4c3ac89395d38/workflows/repo-status.md).
The upstream workflow creates `[repo-status]` issues and closes older reports.
Its docs wrapper's `[team-status]` wording is not the workflow contract.
CAO adds central policy, orchestration, one-target workers, review routing,
fixed windows, bounded reads and per-target rolling reports instead of
workflow-wide closure. The upstream copyright and license are preserved in
[`LICENSE`](https://github.com/githubnext/gh-cao/blob/main/repo-status/LICENSE).
