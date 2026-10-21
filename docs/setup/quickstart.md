---
title: Quickstart
description: Run a standalone Repo Status workflow against an explicitly scoped repository and review your first daily report in CAO.
---

Get your first **Repo Status** report with CAO: add one standalone workflow to
your control repository, select one target, and review yesterday's activity
without writing to the target. No campaign, orchestrator or worker dispatch is
required. Reuse the same workflow against other explicitly enrolled repositories
later; start with one.

## Video walkthrough

:::note[CAO recording not yet available]
A CAO-specific video walkthrough will be added here when the recording is
available. There is no video to play yet. The complete written steps below
work without it.
:::

## 1. Set up your control repository

You need Git, Bash, `curl`, Node.js 24+, GitHub CLI 2.68+, an authenticated
`gh`, and permission to configure Actions and credentials. Use a private control
repository whenever the target or evidence is private or internal. Review
reports inherit that repository's visibility; private Pages access is a
separate setting.

From a clean checkout of your control repository's default branch:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash
gh cao setup
```

In **Repositories**, enter one exact `TARGET_OWNER/TARGET_REPOSITORY`.
Keep the control repository included and no organization wildcards. In
**Connections**, configure an App or fine-grained PAT profile for that scope.
Review and apply. Setup does not commit, push or run agentic work.
If CAO is already configured, reuse your setup rather than reinstalling.

See [Set up and monitor](../setup-quickstarts.md) for the full setup and dashboard
path, and [Authentication](../authentication.md) for credential choices.
Repo Status needs target Contents, Issues, Pull requests and Actions **read**,
plus Issues **write** in the control repository for report safe outputs.
It does not need cross-repository dispatch permissions. Model authentication
is separate: this workflow uses Copilot and needs its model access and AI
credits. Public target visibility does not make every API readable with the
control repository's token.

## 2. Add the standalone workflow

```bash
gh aw add https://github.com/githubnext/gh-cao/blob/main/.github/workflows/repo-status.md
```

This installs the CAO-adapted workflow, not the unmodified upstream workflow.
It reuses the shared runtime installed by CAO setup. To pin a reviewed revision,
replace `main` in the URL with its full commit SHA. Installation does not
execute the workflow or authorize it in CAO.

In `.github/workflows/cao.json`, preserve your existing policy and add this
entry under **`control-plane.workflows`**, not `control-plane.campaigns`:

```json
{
  "repo-status": {
    "enabled": false,
    "mode": "review",
    "max-mode": "review",
    "max-repositories": 1,
    "rollout-percent": 100
  }
}
```

Keep `control-plane.scope.allowed-owners` and `allowed-repositories` restricted
to the exact control repository and target. Keep unrelated workflow and campaign
settings unchanged. The initial **`enabled: false`** blocks agent execution
until the installation and policy have been reviewed.

The workflow is deliberately **manual-only**. Each invocation must name one
target; its read credential is scoped to that repository. CAO verifies that
the target, mode and output destination match the admitted candidate before
the model runs. More enrolled repositories do not widen that credential or
cause an invocation to discover or dispatch additional work.

## 3. Review and publish

```bash
gh aw compile .github/workflows/repo-status.md --schedule-seed githubnext/gh-cao
gh cao doctor
gh cao validate
git status --short
git diff -- .github
```

Review the workflow, generated lock, credentials configuration and policy
together. Confirm there are no secrets, placeholders or extra targets in
policy. Commit using your normal review process and publish to the control
repository's default branch. Check **CAO validation** in Actions.

Once reviewed, change only `control-plane.workflows.repo-status.enabled` to
**`true`**, keeping both review settings and the one-target limit. Validate,
review and publish that policy change too. No schedule starts automatically.

## 4. Request one bounded review

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

Follow **Repo Status** in the control repository's Actions tab. This one
workflow reads the admitted target and produces the report; there is no
orchestrator or second worker run. Review mode executes the model and can
create a report in the control repository: it is not a no-write simulation.
The per-run ceiling is 300 AI credits, plus any gh-aw output check. A ceiling
is not expected consumption.

## 5. Find your report

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

## Customize or expand later

Add optional report priorities in `.github/cao/repo-status.md`; steering cannot
expand authority. To stop future execution, set the standalone workflow's
`enabled` back to `false`, commit and publish, and cancel any active runs.

Run the same workflow with another explicitly enrolled `target_repo` to reuse
it across repositories. It still handles one target per invocation. A reviewed
scheduler can request daily runs with explicit target and routing inputs;
adding a bare schedule does not supply the required target. Recurring runs,
more targets and live target reports each need a separate reviewed decision.
Live delivery also requires the target as `safe_output_repo` and a matching
write credential; this quickstart leaves the policy capped at review.
See [standalone workflow configuration](../configuration.md#standalone-agentic-workflows)
and the [rollout guide](../rollout-and-routing.md). Campaigns are optional when
coordinated work or independent worker scheduling is useful, not a prerequisite
for central governance or cross-repository reporting.

Operational value is not measurable yet: producing a report does not prove
better maintainer understanding or decisions. Report counts and successful runs
are not substitutes for accepted outcome evidence.

This independently maintained CAO variant adapts the
[Agentics Repo Status workflow](https://github.com/githubnext/agentics/blob/ae8d551f07c7ed7619f8c58c7bb4c3ac89395d38/workflows/repo-status.md),
retaining its MIT notice inside the installed source. It does not use the
single-repository gh-aw setup wizard.
