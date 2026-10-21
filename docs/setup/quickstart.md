---
title: Quickstart
description: Run Repo Status across an explicitly scoped repository and review your first daily report in CAO.
---

Get your first **Repo Status** report with CAO: install the campaign in one
control repository, select one target, and review yesterday's activity without
writing to the target. The same campaign can serve more enrolled repositories
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
Review and apply. Setup does not commit, push, install a campaign or run it.
If CAO is already configured, reuse your setup rather than reinstalling.

See [Set up and monitor](../setup-quickstarts.md) for the full setup and dashboard
path, and [Authentication](../authentication.md) for credential choices.
The report worker needs target Contents, Issues, Pull requests and Actions
**read**; dispatch and report safe outputs need Actions/Issues write in the
control repository. Model authentication is separate: these workflows use
Copilot and need its model access and AI credits. Do not assume public target
visibility makes every API readable with the control repository's token.

## 2. Install Repo Status

```bash
gh cao campaigns add githubnext/gh-cao/repo-status
gh cao campaigns mode preview repo-status
```

`preview` is the CLI spelling that writes policy mode **`review`**. Installation
does not execute the campaign. Use `@COMMIT_SHA` on the catalog source to pin a
reviewed revision.

In `.github/workflows/cao.json`, preserve your existing policy and configure
`control-plane.campaigns.repo-status` as follows, replacing the target coordinate:

```json
{
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
```

Keep `control-plane.scope.allowed-owners` and `allowed-repositories` restricted
to the exact control repository and target. The campaign's `targets` entry
narrows that scope; it cannot grant access outside it. Keep all unrelated
campaigns unchanged. The initial **`enabled: false`** prevents the hourly
schedule from doing agentic work while you prepare your first run.

## 3. Review and publish

```bash
gh cao doctor
gh cao validate
git status --short
git diff -- .github repo-status
```

Review workflows, generated locks, credentials configuration and policy
together. Confirm there are no secrets, placeholders or extra targets in
policy. Commit the installation using your normal review process and publish
to the control repository's default branch. Check **CAO validation** in Actions.

Once GitHub recognizes the new workflow, pause its schedule:

```bash
gh workflow disable repo-status.lock.yml
```

Now change only the campaign's `enabled` value to **`true`**, keeping both review
settings and the one-target limit. Validate again, commit that policy change
and publish it. The Actions workflow stays paused until the next step.

## 4. Request one bounded review

Replace all coordinates and `main` with your control repository's actual
default branch. Run this from its checkout. The subshell always pauses the
orchestrator on exit, even if dispatch fails:

```bash
(
  set -e
  trap 'gh workflow disable repo-status.lock.yml' EXIT
  gh workflow enable repo-status.lock.yml
  gh aw run .github/workflows/repo-status.md --ref main \
    --raw-field target_repo="TARGET_OWNER/TARGET_REPOSITORY" \
    --raw-field safe_output_repo="CONTROL_OWNER/CONTROL_REPOSITORY" \
    --raw-field max_repos="1" \
    --raw-field rollout_percent="100" \
    --raw-field safe_output_mode="review"
)
```

Enabling also briefly enables the hourly schedule. Both manual and scheduled
work remain capped by the same reviewed one-target policy. Disabling prevents
future triggers; it does not cancel work already requested. Inspect Actions
and cancel any unwanted queued run rather than dispatching again.

Follow **Repo Status**, then **Repo Status / Report** in the control repository's
Actions tab. The orchestrator only selects and dispatches; the worker reads one
target. This is billable agentic work: configured ceilings are 150 AI credits
for orchestration and 300 for the worker, plus any gh-aw output check. Limits
are not expected consumption.

## 5. Find your report

Open **Issues** in the **control repository**, not the target. Filter by
`repo-status:report`, or run:

```bash
gh issue list --repo CONTROL_OWNER/CONTROL_REPOSITORY \
  --label repo-status:report --state open
```

Look for **`[repo-status:report] TARGET_OWNER/TARGET_REPOSITORY repository status`**.
It summarizes the previous complete UTC day: issues, PRs, default-branch
commits, releases and Actions activity, with one recommended next action.
Expand **Evidence and coverage** for the exact dates and read limits.

A fully read quiet day or an already reported day is a valid **no-op**, so
there may be no issue. Inaccessible required evidence is **incomplete**, not
proof of inactivity. Follow the worker run for that distinction. Successful
dispatch alone does not prove a report was created. Reports expire three days
after creation; later daily reports refresh an owned report's body without
closing another target's issue. Review mode creates no target issue, PR,
comment, branch or code change.

## Customize or expand later

Keep the orchestrator paused after this run. Add optional report priorities in
`.github/cao/repo-status.md`; steering cannot expand authority. For a persistent
stop, set the campaign's `enabled` back to `false`, commit and publish, and
cancel active runs.

Recurring runs, more targets and live target reports each need a separate
reviewed rollout decision. See the
[Repo Status campaign](https://githubnext.github.io/gh-cao/catalog/repo-status/)
and [rollout guide](../rollout-and-routing.md).
This campaign adapts the
[Agentics Repo Status workflow](https://github.com/githubnext/agentics/blob/ae8d551f07c7ed7619f8c58c7bb4c3ac89395d38/workflows/repo-status.md)
to CAO's central policy and review semantics; it does not use the single-repo
gh-aw setup wizard.
