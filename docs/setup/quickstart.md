---
title: Repo Status quickstart
description: Run a standalone Repo Status workflow against an explicitly scoped repository and review your first daily report in CAO.
---

Get your first **Repo Status** report with CAO: add one standalone workflow to
your control repository, select one target, and review yesterday's activity
without writing to the target. By the end of this guide, you will have requested
one bounded review and know where to find its report or no-op explanation.

**Estimated time: 15 minutes after setup**, plus credential approval,
review, and workflow execution time. No campaign, orchestrator or worker
dispatch is required.

:::note[CAO recording not yet available]
**Video TODO:** record adding Repo Status, requesting one review-mode run, and
opening its report in the control repository. There is no video to play yet;
follow the written steps below.
:::

## Prerequisites

<span id="step-1---set-up-cao-and-monitor-one-repository"></span>

- **A configured CAO control repository.** Complete [Set Up CAO](../setup-quickstarts.md)
  first: install the extension and runtime, connect one repository, and publish
  your dashboard. Return here for optional automation; monitoring alone does
  not run Repo Status. Reuse your setup and start from a clean checkout of
  the control repository's default branch.
- **One target repository.** Keep exact scope for
  `TARGET_OWNER/TARGET_REPOSITORY` and the control repository, not organization
  wildcards. Use a private control repository for private or internal evidence:
  reports inherit its visibility, and private Pages access is a separate setting.
- **Repository credentials.** Repo Status needs target Contents, Issues,
  Pull requests and Actions **read**, plus Issues **write** in the control
  repository for report safe outputs. It does not need cross-repository dispatch
  permissions. See [Authentication](../authentication.md); public visibility
  does not make every API readable with the control repository's token.
- **Model access.** This workflow uses Copilot and needs its model authentication
  and AI credits, separately from repository credentials. Review the workflow's
  data handling, permitted integrations, and access to logs and artifacts before
  its first run.

<span id="step-2---add-and-review-the-sample-workflow"></span>

## Step 1 - Add and review the sample workflow

From your control repository's checkout, install the CAO Repo Status workflow:

```bash
gh cao add repo-status
```

This installs the CAO-adapted workflow, not the unmodified upstream workflow.
It reuses the shared runtime installed by CAO setup and delegates installation
and compilation to `gh aw add`. To pin a reviewed revision, use
`gh cao add repo-status@FULL_COMMIT_SHA`. The explicit source is
`githubnext/gh-cao/.github/workflows/repo-status.md`, not
`githubnext/gh-cao/daily-repo-status`: gh-aw's short source form searches
`workflows/`, whereas CAO maintains this workflow under `.github/workflows/`.
Use a released extension containing `add`; upgrade with
`gh extension upgrade gh-cao` if the command is unavailable.

### Automatic registration

After a successful install, CAO adds this entry in
`.github/workflows/cao.json` under **`control-plane.workflows`**,
not `control-plane.campaigns`. No manual registration is needed:

```json
{
  "repo-status": {
    "mode": "review",
    "max-mode": "review",
    "max-repositories": 1
  }
}
```

Existing registrations, scope, defaults and campaign settings are preserved.
Failed installs do not register the workflow. Adding it again with `--force`
refreshes installed files without resetting its policy, including an explicit
disable. Keep `control-plane.scope.allowed-owners` and `allowed-repositories`
restricted to the exact control repository and target.

New registrations are capped at **review** mode and **one repository**, even
when global defaults are live. Rollout still inherits your existing defaults
(**100%** when unspecified). Registered workflows are enabled unless explicitly
disabled; registration does not enroll targets or dispatch a run. See
[configuration](../configuration.md#standalone-agentic-workflows) for optional
overrides and mode ceilings.

The workflow is deliberately **manual-only**. Each invocation must name one
target; its read credential is scoped to that repository. CAO verifies that
the target, mode and output destination match the admitted candidate before
the model runs. More enrolled repositories do not widen that credential or
cause an invocation to discover or dispatch additional work.

### Review and publish

In an interactive terminal, `add` offers a separate default-No **commit and push**
confirmation with a change summary and full diff. It publishes only installation
changes, and refuses automated publication if those files had pre-existing edits,
the index is staged, or the checkout is not synchronized with the remote default
branch. Unrelated dirty files are not staged. Declining leaves the installation
local for your normal review process.

After publication, a separate default-No **first run** confirmation is offered.
Supply the target and required inputs; review the request before approving.
Running can spend AI credits and create report outputs. The first-run helper
requests review mode on the published branch, checks explicit scope and the
branch's revision, and verifies the returned run matches the published commit.
It does not wait for workflow execution: if the workflow is not yet available in
Actions, it reports that instead of retrying dispatch. The workflow's normal
CAO admission checks still apply.

Noninteractive/CI invocations never publish or run. An unchanged repeated add
does not prompt again. If you decline either step, use the manual steps below.

```bash
gh aw compile .github/workflows/repo-status.md --schedule-seed githubnext/gh-cao
gh cao doctor
git status --short
git diff -- .github
```

Review the workflow, generated lock, credentials configuration and policy
together. Confirm there are no secrets, placeholders or extra targets in
policy. Commit using your normal review process and publish to the control
repository's default branch. Check **CAO validation** in Actions.

Publishing this manual-only workflow does not start a run or a schedule unless
you separately approve its first run. If you approved that run, continue with
Step 3 rather than dispatching it again.

<span id="step-3---request-one-bounded-review"></span>

## Step 2 - Request one bounded review

Replace all coordinates and `main` with your control repository's actual
default branch. Run this from its checkout:

```bash
gh aw run .github/workflows/repo-status.md --ref main \
  --raw-field target_repo="TARGET_OWNER/TARGET_REPOSITORY" \
  --raw-field safe_output_repo="CONTROL_OWNER/CONTROL_REPOSITORY" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

This one workflow reads the admitted target and produces the report; there is
no orchestrator or second worker run. Review mode executes the model and can
create a report in the control repository: it is not a no-write simulation.
The per-run ceiling is 300 AI credits, plus any gh-aw output check. A ceiling
is not expected consumption.

<span id="step-4---wait-for-the-run-and-inspect-its-result"></span>

## Step 3 - Wait for the run and inspect its result

Open the control repository's **Actions** tab and follow **Repo Status**.
Allow time for model execution and output checks; the workflow has a
20-minute timeout. Dispatching again requests new work, not a status check.
If the run fails, open its step logs before retrying.

Open **Issues** in the **control repository**, not the target. Filter by
`repo-status`, or run:

```bash
gh issue list --repo CONTROL_OWNER/CONTROL_REPOSITORY \
  --label repo-status --state open
```

Look for **`[repo-status] TARGET_OWNER/TARGET_REPOSITORY repository status`**.
It summarizes the previous complete UTC day: issues, PRs, default-branch
commits, releases and Actions activity, with one recommended next action.
Expand **Evidence and coverage** for the exact dates and read limits.

A fully read quiet day, an excluded target or an already reported day is a
valid **no-op**, so there may be no issue. Inaccessible required evidence is
**incomplete**, not proof of inactivity. Follow the run for that distinction.
Reports expire three days after creation; later daily reports refresh an owned
report's body without closing another target's issue. Review mode creates no
target issue, PR, comment, branch or code change.

<span id="step-5---customize-your-report-optional"></span>

## Step 4 - Customize your report (optional)

Add optional report priorities in `.github/cao/repo-status.md`; steering cannot
expand authority. Review, commit, and publish your steering change, then repeat
Step 2 with the same target and review-mode inputs to try it. Edit the Markdown
workflow source, not its generated `.lock.yml`; if you change the workflow,
repeat Step 1's compile, validation, and review before running again.

To stop future execution, set the standalone workflow's
`enabled` to `false`, commit and publish, and cancel any active runs.

### Expand only after a separate review

Run the same workflow with another explicitly enrolled `target_repo` to reuse
it across repositories. It still handles one target per invocation. A reviewed
scheduler can request daily runs with explicit target and routing inputs;
adding a bare schedule does not supply the required target. Recurring runs,
more targets and live target reports each need a separate reviewed decision.
Live delivery also requires the target as `safe_output_repo` and a matching
write credential; this quickstart requests review mode only.
See [standalone workflow configuration](../configuration.md#standalone-agentic-workflows)
and the [rollout guide](../rollout-and-routing.md). Campaigns are optional when
coordinated work or independent worker scheduling is useful, not a prerequisite
for central governance or cross-repository reporting.

Operational value is not measurable yet: producing a report does not prove
better maintainer understanding or decisions. Report counts and successful runs
are not substitutes for accepted outcome evidence.

## Continue learning

- [Explore the dashboard](../dashboard.md) for collected run evidence.
- [From outcome to execution](../operation-patterns.md) for other operating patterns.
- [Standalone workflow configuration](../configuration.md#standalone-agentic-workflows)
  for policy and admission.
- [Rollout and routing](../rollout-and-routing.md) before expanding authority.
- [Repo Assist walkthrough](../repo-assist-quickstart.md) for an optional campaign
  with separate orchestrator and worker runs.

This independently maintained CAO variant adapts the
[Agentics Repo Status workflow](https://github.com/githubnext/agentics/blob/ae8d551f07c7ed7619f8c58c7bb4c3ac89395d38/workflows/repo-status.md),
retaining its MIT notice inside the installed source. It does not use the
single-repository gh-aw setup wizard.
