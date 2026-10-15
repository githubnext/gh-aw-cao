---
title: CAO Quickstart
description: Run one bounded Repo Assist maintenance proposal in review mode and open your first CAO dashboard.
---

Your first Central Agentic Ops (CAO) run answers a practical question:
**can Repo Assist make one useful maintenance improvement?**
You do not need existing Agentic Workflows, Actions history, or telemetry.

Repo Assist's existing maintenance worker selects **one concrete, low-risk improvement**,
prepares a small patch in a local checkout, and validates it with available
trusted tooling. It publishes one control-repository review issue and downloadable
review bundle. It never applies changes to the target repository.
**A no-op is a valid result** when no useful, non-duplicate, verifiable change fits.

This is a normal Repo Assist run, including duplicate checks, implementation,
and focused validation. There is no onboarding-only worker, snapshot helper,
or reduced assessment profile. Missing required evidence remains incomplete,
not an invented finding. Detailed validation goes in the review bundle.
Requested review-bundle files are persisted through gh-aw's secret-redacted
agent artifact before publication; missing requested evidence fails the
publish job rather than reporting success without a bundle.

**None of the proposals is a requirement for using CAO.** Tests, CI,
`AGENTS.md`, and contributor templates are not eligibility requirements.
There are no readiness grades or required practice checklists. The repository
can stay exactly as it is; CAO admission is governed by policy and access.

With no explicit target, quickstart uses the public CAO repository
[`githubnext/gh-aw-cao`](https://github.com/githubnext/gh-aw-cao) as a real
example, using the normal worker checkout.
Its existing automations are not prerequisites for your own repository.
No demo repository is created, and useful findings are not guaranteed.

**Time:** depends on GitHub Actions queueing, installation, and dashboard deployment.
The normal workflow timeouts are 15 minutes for orchestration and 45 minutes
for maintenance; these are ceilings, not measured completion times.

**You get:** a private control repository, a validated maintenance proposal or no-op,
and a public GitHub Pages dashboard.

## 1. Check your tools

You need Git, Bash, `curl`, Node.js 24+, GitHub CLI 2.68+, and GitHub Models
access. Confirm that GitHub CLI is signed in:

```bash
gh --version
node --version
gh auth status
```

Run `gh auth login` if needed.

## 2. Run the quickstart

For the simplest experience, run this outside a Git checkout:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart
```

To use your own existing public repository immediately, replace the final
line with `bash -s -- --quickstart --target OWNER/REPOSITORY`.

Outside a checkout, quickstart creates private `USERNAME/cao` when both that
repository name and the local clone path are available. Otherwise it selects a
fresh UTC timestamped name, such as `USERNAME/cao-20261014-111151`, and prints
the choice before creation. If that timestamp is also occupied, it checks
numeric suffixes (`-2`, `-3`, and so on), stopping after ten timestamped
candidates. Existing repositories and local files are never reused or overwritten.
Use `--create-repo OWNER/NAME` for an exact name; an explicit name is never
silently changed. To reuse an existing control repository, run from its clean
checkout instead.

With no catalog source, `--quickstart` resolves the latest stable CAO `vX.Y.Z`
release and pins the control plane, Repo Assist campaign, and verified
release runtime to its immutable commit. It fails closed if a stable release
cannot be resolved; it never silently falls back to `main`. Maintainers can opt
into the development build by passing `githubnext/gh-aw-cao@main` before
`--quickstart`.

Then watch CAO:

1. Pin the latest stable CAO release.
2. Create private `USERNAME/cao` (or its timestamped fallback), your control repository.
3. Select the public example or validate your explicit public target.
4. Install Repo Assist in `review` mode for that exact target.
5. Enable only its existing maintenance worker and dispatch ordinary Repo Assist.
6. Pause the orchestrator after dispatch to prevent automatic six-hour reruns;
   the requested run continues to select, implement, and validate one improvement.
7. Publish one review proposal and patch bundle only in the control repository,
   or record a no-op without manufacturing work.
8. Collect a CAO Activity snapshot and require at least one collected run.
9. Wait for the data-bearing dashboard deployment.

The command shows progress while GitHub Actions does the longer work.
Quickstart works without a terminal and when `CI` is set.

> [!TIP]
> **The maintenance outcome is the first useful result.** When the Repo Assist
> maintenance worker completes, inspect its run outcome and any control review
> issue or review-bundle artifact. Success alone does not imply a patch was
> produced or applied. Activity collection and dashboard deployment continue afterward.

> [!NOTE]
> Quickstart publishes a public GitHub Pages dashboard. Under default limits,
> one run can consume up to **1,250 AI credits**: 250 orchestration + 600
> maintenance + 400 model-based output checking. Output-check limits are
> configurable, so configured consumption ceilings may differ.
> Credits are an execution ceiling, not a measured token count or cost estimate.
> There is no second confirmation: `--quickstart` is your approval for
> control-repository creation when needed, the bounded commit and push, and
> workflow runs.

## 3. Open your dashboard

Quickstart waits for real Activity data and prints a summary like this:

```text
CAO quickstart complete.
Dashboard: https://USERNAME.github.io/cao/
Target: https://github.com/githubnext/gh-aw-cao (public Repo Assist example)
Repo Assist: https://github.com/USERNAME/cao/actions/runs/... (success)
Activity: https://github.com/USERNAME/cao/actions/runs/... (... collected runs)
Control repository: https://github.com/USERNAME/cao
```

Open **Dashboard**, select **Repo Assist**, then open **Reports**.
Use the actual repository name and dashboard URL printed by quickstart; a
timestamped control repository has its own matching dashboard URL.
If there is a proposal, open its review issue and download the patch bundle
from the worker run's Artifacts section. Review the observed problem, smallest
change, application prompt, and exact validation outcomes before deciding
whether to apply it. Applying the proposal is not a requirement for using CAO.
If there is no issue, inspect the worker's no-op or incomplete reason.
There are no pass/fail or readiness ratings of the repository.

Only the existing maintenance worker is enabled by quickstart. The orchestrator
is paused after its requested dispatch, so it will not automatically run every
six hours. Re-enable it explicitly for further work; enabling additional workers
or live authority is a separate reviewed policy decision.

## What this demonstrates

- **Useful before automation.** A repository can receive a maintenance proposal
  without installing any Agentic Workflows in the target.
- **Evidence, not checklist theater.** Finding a configured command is different
  from observing a successful run; missing access stays unassessed.
- **Real work, not a readiness assessment.** One evidence-backed, validated
  improvement demonstrates Repo Assist, with no preparation checklist.
- **One target uses the fleet machinery.** Policy resolution, repository
  isolation, bounded dispatch, and review routing remain the same when the
  campaign expands.
- **The maintainer keeps control.** A review patch does not become an applied
  change, target issue, pull request, or enabled workflow.

CAO configures Pages and repository `GITHUB_TOKEN` access, then commits only
its runtime and policy to the control repository. The shared starter target is never modified.
Installer-created control repositories remain private. In a public control repository,
policy, workflow runs, dashboard data, and review outputs are also public.

## See more without running more

Quickstart intentionally runs only Maintenance. Explore
[real Repo Assist examples](https://github.com/githubnext/gh-aw-cao/blob/main/repo-assist/README.md#see-repo-assist-in-action)
from our own control plane to see issue triage, issue-fix proposals, maintenance,
and a PR-upkeep blocker review. Each example links its report and originating
run and states the observed outcome, including the failed, no-patch upkeep run.
These are historical reports, not proof of applied or merged changes.

Reading them does not start a workflow or spend AI credits. You do not need to
enable every worker, create a demo repository, or reproduce the showcase to
complete onboarding. Your one real maintenance run may honestly produce a no-op.

## Next: assist another repository

Reuse the same control repository and installed Repo Assist campaign.
Do not run the installer or `cao add` again.
Replace `USERNAME/cao` below with the actual control repository printed by
quickstart, including any timestamp suffix.

In the control repository, edit `.github/workflows/cao.json`:

1. Add `OWNER` to `control-plane.scope.allowed-owners`.
2. Replace the sample repository with `OWNER/REPOSITORY` in
   `control-plane.scope.allowed-repositories`, retaining `USERNAME/cao`.
3. Replace the sample entry under
   `control-plane.campaigns.repo-assist.targets` with
   `"OWNER/REPOSITORY": { "mode": "review" }`.

Keep `control-plane.activity.repositories` set to `USERNAME/cao`; Activity
collects the control-plane runs, not source data from the target.

Validate, commit, and push the reviewed policy change:

```bash
./cao.sh validate
git add .github/workflows/cao.json
git commit -m "Target Repo Assist at OWNER/REPOSITORY"
git push
```

Then run the already-installed campaign:

```bash
gh workflow enable repo-assist.lock.yml
gh aw run repo-assist --ref main \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field safe_output_repo="USERNAME/cao" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

CAO still runs in `review` mode and never modifies the target.
Re-enabling also resumes Repo Assist's six-hour schedule. For another one-off
run, use `gh workflow disable repo-assist.lock.yml` after dispatch to pause
further scheduled work without cancelling the requested run.

## Already have a control repository?

Run the quickstart at the root of a clean public or private control repository on its default branch.
Existing commits are preserved; staged, unstaged, or untracked changes stop the
quickstart before installation. See the [CAO CLI guide](cao-cli.md) to choose a
different control-repository name.

## Need more control?

Use guided setup for private targets, a private dashboard, organization-wide
scope, App or PAT credentials, or review before changes:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --setup
```

Guided setup installs no campaign and runs no workflow; it never commits or
pushes. Bare installation also stops without a prompt and prints
`Next: ./cao.sh setup`. It offers authentication choices based on that scope
and shows each profile's prerequisites before applying it.

For an optional first look, start with **Repo Assist** after guided setup:
`./cao.sh add githubnext/gh-aw-cao/repo-assist`.

See [Control Plane Authentication Profiles](control-plane-authentication.md)
for advanced authentication choices.

## If quickstart stops

- **The default name or clone path already exists:** quickstart automatically
  selects a timestamped name. To reuse the existing control repository, run
  from its clean checkout; to select an exact new name, use `--create-repo OWNER/NAME`.
- **A repository-name lookup fails:** restore GitHub access or availability and
  retry. Lookup failures are not treated as proof that a name is available.
- **An explicit name is occupied or all ten timestamped names are occupied:**
  select an available exact name with `--create-repo OWNER/NAME`.
- **The target is inaccessible:** restore repository access or GitHub
  availability; quickstart does not substitute another target.
- **Required evidence is inaccessible or validation cannot complete:** inspect
  Repo Assist's incomplete or no-op reason; success is not a readiness pass.
- **Pausing the workflow fails:** quickstart reports the error explicitly.
  Run `gh workflow disable repo-assist.lock.yml` in the control repository
  to prevent recurring runs before troubleshooting.

Quickstart never reports a dashboard URL until Activity contains real run data
and the matching dashboard deployment succeeds.
