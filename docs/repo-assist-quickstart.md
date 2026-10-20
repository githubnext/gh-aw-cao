---
title: Try a Repo Assist review
description: Optional campaign walkthrough to propose one maintenance improvement in review mode, collect evidence, and explore the result.
---

This optional walkthrough installs and runs a campaign. To monitor existing
Agentic Workflows without adding a campaign, start with [Set Up CAO](setup-quickstarts.md).
After setup, use the [campaign catalog](https://githubnext.github.io/gh-cao/catalog/)
to add a campaign without reinstalling.

This guide introduces Central Agentic Ops (CAO) one component at a time.
Each command finishes its own stage and tells you what to do next.
You can stop between stages; you do not need to keep a terminal waiting for
GitHub Actions.

| Component | What you learn | Checkpoint |
| --- | --- | --- |
| **Control repository** | Where workflows, credentials, and rollout policy live | Inspect the installed policy before running anything |
| **Repo Assist campaign** | How an orchestrator selects work and a worker proposes a change | Review a proposal, no-op, or incomplete outcome |
| **Activity** | How workflow evidence becomes dashboard data | Inspect the collection run and its artifact |
| **Dashboard** | How collected evidence is published for exploration | Open the verified, data-bearing Pages deployment |

Your first campaign run answers a practical question:
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

Choose the public target explicitly with `--target TARGET_OWNER/TARGET_REPOSITORY`.
Quickstart does not suggest or select an owner or repository for you.
The target uses the normal worker checkout.
No demo repository is created, and useful findings are not guaranteed.

**You build:** a private control repository, a review-only campaign, an Activity
snapshot, and a public GitHub Pages dashboard. Installation does not automatically
start the campaign or wait for a dashboard.

## 1. Check your tools

You need Git, Bash, `curl`, Node.js 24+, GitHub CLI 2.68+, and GitHub Models
access. Confirm that GitHub CLI is signed in:

```bash
gh --version
node --version
gh auth status
```

Run `gh auth login` if needed.

## 2. Install and understand the control plane

Choose a control repository and an existing public target before installing.
In the command below, replace both coordinates with your choices; the uppercase
names are placeholders, not suggested owners or repositories.
Run this outside a Git checkout to create a new private control repository:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh |
  bash -s -- --quickstart \
    --create-repo CONTROL_OWNER/CONTROL_REPOSITORY \
    --target TARGET_OWNER/TARGET_REPOSITORY
```

To use an existing control repository, run from its clean default-branch checkout
and omit `--create-repo`; keep the explicit `--target` argument.
To enter the control owner and name interactively, use `--create-repo` without
a coordinate. Neither prompt has a default; blank input does not select one.
Headless creation requires `--create-repo OWNER/NAME`.
Existing repositories and local files are never reused or overwritten.
An explicit name is never silently changed: if it is occupied, choose a different
coordinate yourself, or use the existing repository's clean checkout.
Missing `--target` stops before installation or repository creation; the later
run, collect, and dashboard stages reuse the target in committed policy.

With no catalog source, `--quickstart` resolves the latest published CAO `vX.Y.Z`
release, including prereleases but excluding drafts, and pins the control plane,
Repo Assist campaign, and verified release runtime to its immutable commit.
It fails closed if a published release
cannot be resolved; it never silently falls back to `main`. Maintainers can opt
into the development build by passing `githubnext/gh-cao@main` before
`--quickstart`.

The command teaches these choices in five numbered sections **before each
corresponding change**, rather than hiding them in a transient progress line:

1. **Repositories and source:** the actual control repository, visibility,
   default branch, local checkout, public target, why it was selected, and
   the selected Repo Assist package revision.
2. **Installed components:** the CLI and runtimes, core workflows, Repo Assist
   orchestrator and worker files, and the roles they play.
3. **Authority:** the policy file, exact repository and Activity scopes,
   review mode, one-target limit, enabled/disabled workers, and output routing.
4. **Connections:** repository-token authentication and the public Pages
   dashboard, even when the control repository is private.
5. **Publication:** the bounded paths, commit identity, default-branch push,
   and orchestrator pause, including independent Activity triggers.

These explanations stay in terminal scrollback, including in plain/CI output;
they are not truncated spinner messages. Each stage finishes with **Before
continuing** instructions telling you what to inspect before its **Next**
command. There are no extra confirmation prompts or automatic advances to the
next stage. With `--json`, progress is silent and the installation result
includes the same numbered `guide` details and its `checkpoint`.

This stage will:

1. Install Repo Assist pinned to the same CAO release.
2. Configure only its existing maintenance worker in `review` mode for the exact
   public target, with Activity scope limited to the control repository.
3. Configure public Actions-backed Pages and repository-token authentication.
4. Commit and push only the bounded CAO paths, then pause the Repo Assist
   orchestrator so its six-hour schedule does not start recurring work.

It does **not** dispatch Repo Assist or Activity, or wait for remote jobs.
The quickstart works without a terminal and when `CI` is set.
The installed Activity workflow still has its normal push and scheduled
triggers, so the installation commit can start a baseline collection and
dashboard build automatically. That does not run Repo Assist or replace the
post-review snapshot you request in step 4.

**Checkpoint:** enter the control-repository directory printed by the installer.
Run every remaining command from that checkout, not from the target repository.
Inspect `.github/workflows/cao.json` and `.github/workflows/`:

- **Policy** names the exact target, keeps the campaign in `review`, and caps
  selection at one repository. Credentials alone do not authorize more targets.
- **Orchestrator** (`repo-assist`) selects and dispatches bounded work.
- **Worker** (`repo-assist-maintenance`) analyzes that one target and publishes
  review outputs in the control repository, never in the target.
- **Activity and Dashboard workflows** collect and publish evidence separately.

You are ready for the next step when the installed policy matches the repository
you intend to assist. Do not rerun installation to continue.

> [!NOTE]
> Quickstart configures a public GitHub Pages dashboard. Starting Repo Assist in
> the next stage can consume up to **1,250 AI credits**
> under default limits:
> 250 orchestration + 600
> maintenance + 400 model-based output checking. Output-check limits are
> configurable, so configured consumption ceilings may differ.
> Credits are an execution ceiling, not a measured token count or cost estimate.
> There is no second confirmation: `--quickstart` approves control-repository
> creation when needed, configuration, and the bounded commit and push.
> The separate `run` and `collect` commands authorize their workflow dispatches.

## 3. Run one Repo Assist review

Start the campaign only when you are ready:

```bash
node activity/cao.mjs quickstart --step run
```

This uses the target already recorded in policy; it does not reinstall or
broaden scope. It briefly enables the orchestrator, dispatches one bounded
review, and pauses it again, including if dispatch fails.
The requested run continues while your terminal returns.

Open the printed Actions link. First inspect **Repo Assist**, then the
**Repo Assist maintenance** worker it dispatches. GitHub Actions queueing and
normal workflow timeouts still apply; splitting the guide does not make the
remote work synchronous or reduce its analysis.

**Checkpoint:** wait in Actions, not in the installer, until the orchestrator
and any dispatched maintenance worker finish. If there is a proposal, open its
control review issue and download the review bundle from the worker run's
Artifacts section. Review the observed problem, proposed change, application
prompt, and exact validation outcomes before deciding whether to apply it.
If there is no proposal, inspect the no-op, blocked, failed, or incomplete reason.
Success alone does not imply a patch was produced or applied.

The maintenance outcome is your first useful result. Applying a proposal is
not a requirement for using CAO, and there are no pass/fail readiness ratings.
Do not repeat `--step run` just to check progress: it requests another run.

## 4. Collect a CAO Activity snapshot

Activity turns the control-plane workflow runs into evidence the dashboard can
display. It does not rerun the maintenance analysis or apply a proposal.
After reviewing the completed campaign, request collection:

```bash
node activity/cao.mjs quickstart --step collect
```

The command dispatches Activity and returns its Actions link without waiting.
**Checkpoint:** inspect **CAO Activity** in Actions and its data artifact.
We require at least one collected run before calling the dashboard ready.
A successful Activity run triggers Dashboard publication automatically.
Do not repeat `--step collect` as a status check; it requests a new snapshot.

## 5. Check and explore your dashboard

Check publication without starting another workflow:

```bash
node activity/cao.mjs quickstart --step dashboard
```

This read-only step checks for successful, data-bearing Activity and its
subsequent successful Pages deployment job, not merely a successful build.
If either is pending, inspect the
printed Actions link and repeat **only this command** later. It does not poll
until completion or report a ready dashboard prematurely.

**Checkpoint:** open the verified Dashboard URL, select **Repo Assist**, then
open **Reports**. Follow the report back to its run and review evidence.
Use the actual control-repository name and URL printed by quickstart; a
control repository has its own matching dashboard URL.

You have now followed the complete path: **policy → orchestrator → worker →
Activity → dashboard**. The orchestrator remains paused. Enabling additional
workers or live authority is a separate reviewed policy decision.

### Optional: wait for the whole flow

For deliberate unattended use immediately after bare installation,
`node activity/cao.mjs quickstart --wait --target TARGET_OWNER/TARGET_REPOSITORY` retains the end-to-end installation, run,
collection, and deployment flow. It commits and pushes, starts workflows, and
waits for remote completion. Do not use it to resume a staged installation or
as a status check. The staged guide above is the default onboarding experience.

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
its runtime and policy to the control repository. The selected target is never modified.
Installer-created control repositories remain private. In a public control repository,
policy, workflow runs, dashboard data, and review outputs are also public.

## See more without running more

Quickstart intentionally runs only Maintenance. Explore
[real Repo Assist examples](https://github.com/githubnext/gh-cao/blob/main/repo-assist/README.md#see-repo-assist-in-action)
from our own control plane to see issue triage, issue-fix proposals, maintenance,
and a PR-upkeep blocker review. Each example links its report and originating
run and states the observed outcome, including the failed, no-patch upkeep run.
These are historical reports, not proof of applied or merged changes.

Reading them does not start a workflow or spend AI credits. You do not need to
enable every worker, create a demo repository, or reproduce the showcase to
complete onboarding. Your one real maintenance run may honestly produce a no-op.

## Next: assist another repository

Reuse the same control repository and installed Repo Assist campaign.
Do not run the installer or `gh cao campaigns add` again.
Replace `CONTROL_OWNER/CONTROL_REPOSITORY` below with your actual control
repository, and `OWNER/REPOSITORY` with the new target you choose.

In the control repository, edit `.github/workflows/cao.json`:

1. Add `OWNER` to `control-plane.scope.allowed-owners`.
2. Replace the previous target with `OWNER/REPOSITORY` in
   `control-plane.scope.allowed-repositories`, retaining `CONTROL_OWNER/CONTROL_REPOSITORY`.
3. Replace the previous target entry under
   `control-plane.campaigns.repo-assist.targets` with
   `"OWNER/REPOSITORY": { "mode": "review" }`.

Keep `control-plane.activity.repositories` set to `CONTROL_OWNER/CONTROL_REPOSITORY`; Activity
collects the control-plane runs, not source data from the target.

Inspect, commit, and push the reviewed policy change:

```bash
git diff -- .github/workflows/cao.json
git add .github/workflows/cao.json
git commit -m "Target Repo Assist at OWNER/REPOSITORY"
git push
```

Wait for **CAO validation** to pass in Actions, then run the already-installed campaign:

```bash
gh workflow enable repo-assist.lock.yml
gh aw run repo-assist --ref main \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field safe_output_repo="CONTROL_OWNER/CONTROL_REPOSITORY" \
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
  https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh |
  bash -s -- --setup
```

Guided setup installs no campaign and runs no workflow; it never commits or
pushes. Bare installation also stops without a prompt and prints
`Next: gh cao setup`. It offers authentication choices based on that scope
and shows each profile's prerequisites before applying it.

For an optional first look, start with **Repo Assist** after guided setup:
`gh cao campaigns add githubnext/gh-cao/repo-assist`.

See [Control Plane Authentication Profiles](control-plane-authentication.md)
for advanced authentication choices.

## If quickstart stops

- **An owner, control name, or target was not selected:** provide
  `--create-repo OWNER/NAME` when creating a control repository, and always
  provide `--target OWNER/REPOSITORY` for installation. No coordinate is inferred.
- **A repository-name lookup fails:** restore GitHub access or availability and
  retry. Lookup failures are not treated as proof that a name is available.
- **The chosen name or local clone path is occupied:** select an available exact
  name with `--create-repo OWNER/NAME`, or use the existing repository's clean
  checkout. Quickstart never generates a fallback name.
- **The target is inaccessible:** restore repository access or GitHub
  availability; quickstart does not substitute another target.
- **Required evidence is inaccessible or validation cannot complete:** inspect
  Repo Assist's incomplete or no-op reason; success is not a readiness pass.
- **Pausing the workflow fails:** quickstart reports the error explicitly.
  Run `gh workflow disable repo-assist.lock.yml` in the control repository
  to prevent recurring runs before troubleshooting.

If installation succeeded, continue with the next stage rather than reinstalling.
For failed remote jobs, inspect the run's logs before requesting new work.
The dashboard check never reports readiness until Activity contains real run data
and the matching dashboard deployment succeeds.
