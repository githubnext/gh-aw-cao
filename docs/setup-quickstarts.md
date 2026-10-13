---
title: CAO Quickstart
description: Create a disposable Bug Bash sample and reach a data-bearing CAO dashboard with one command.
---

Central Agentic Ops (CAO) runs bounded agentic operations from a control
repository. This quickstart uses a clean existing public or private repository,
or creates the private control repository `USERNAME/cao`. By default it creates
the disposable public target `USERNAME/cao-sample` with intentional bugs, runs
one review-only Bug Bash against it, collects the resulting Activity, and
deploys a public dashboard containing the first data.

**Estimated time: 15-25 minutes**

## Before you start

You need:

- **GitHub account:** Permission to push the selected control repository's
  default branch and configure its GitHub Pages site, plus permission to create
  repositories in your personal namespace for the default journey.
- **GitHub CLI:** `gh` v2.68.0 or newer. [Install it](https://cli.github.com/)
  and check with `gh --version`.
- **GitHub CLI sign-in:** Check with `gh auth status`; run `gh auth login` if
  needed.
- **Local tools:** Git, Bash, `curl`, and Node.js v24 or newer.
- **GitHub Models access:** The Bug Bash run can consume up to **700 AI
  credits**: 200 for selection and 500 for one investigation.

The quickstart publishes a **public GitHub Pages dashboard** and creates a
**public sample repository**. The sample README warns that its deterministic
defects are intentional and that its code is not for production. After that
initial creation, the starter target is never modified by CAO.
In a public control repository, the checked-in policy, workflow runs, dashboard
data, and review outputs are also public. Do not use this path if any resulting evidence
must remain private; use [Guided setup](#guided-setup-instead) in a private
control repository instead.

## Run the quickstart

From the root of a clean public or private control repository checkout on its
default branch:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart
```

This path works without a terminal and when `CI` is set. Existing commits are
preserved; quickstart creates one bounded CAO commit on top. It stops before
installation when the checkout has staged, unstaged, or untracked changes.

Run the command outside a Git checkout to create `USERNAME/cao` automatically.
Installer-created control repositories remain private. If that repository
already exists, quickstart stops rather than reusing, overwriting, or inventing
a suffixed name; run from its clean checkout or pass an exact
`--create-repo OWNER/NAME`.

The explicit `--quickstart` flag authorizes one bounded first-success journey:

1. Install and verify the CAO runtime.
2. Create the public `USERNAME/cao-sample` target with intentional bugs, or
   verify the existing public repository passed with `--target OWNER/REPO`.
3. Install Bug Bash in `review` mode for only that exact target.
4. Configure repository-local `GITHUB_TOKEN` access for public source reads and
   control-repository operations.
5. Configure public GitHub Pages with GitHub Actions as its source.
6. Commit and push only `.github/`, `activity/`, `dashboard/`, `bug-bash/`,
   `cao.sh`, and gh-aw's `.gitattributes` and `.vscode/settings.json`.
7. Dispatch one Bug Bash orchestrator and at most one investigation worker.
8. Collect a CAO Activity snapshot and require at least one collected run.
9. Wait for the data-bearing dashboard deployment and print its URL.

The local installation phases show elapsed progress and should finish well
before the GitHub Actions work. Most of the estimated time is the bounded Bug
Bash investigation, Activity collection, and dashboard deployment running on
GitHub; the quickstart keeps the active phase and elapsed time visible.

There is no second confirmation after repository selection: `--quickstart` is
the explicit authorization for these effects, including in headless use. A
`no-finding` Bug Bash result is still successful. Missing model entitlement,
missing permissions, workflow failure, or an empty Activity artifact is
reported as blocked or failed rather than as success.

For non-interactive creation of a new private repository, provide the exact
coordinate:

```bash
CONTROL_REPOSITORY="OWNER/cao"

curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart --create-repo "$CONTROL_REPOSITORY"
```

To review an existing public repository instead of creating `USERNAME/cao-sample`,
provide its exact coordinate:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart --target OWNER/REPOSITORY
```

The default sample name is never reused automatically. If
`USERNAME/cao-sample` already exists, delete it before retrying or pass
`--target USERNAME/cao-sample` to review that existing public repository.

## Confirm first success

The command finishes only after the dashboard workflow succeeds and Activity
contains at least one run. Its final summary includes:

```text
CAO quickstart complete.
Dashboard: https://OWNER.github.io/cao/
Target: https://github.com/USERNAME/cao-sample (sample with intentional bugs)
Bug Bash: https://github.com/OWNER/cao/actions/runs/... (success)
Activity: https://github.com/OWNER/cao/actions/runs/... (... collected runs)
Control repository: https://github.com/OWNER/cao
```

Open the dashboard URL. Bug Bash review evidence, including a possible
`no-finding` result, remains in the control repository and is public when that
repository is public.

## Guided setup instead

Use guided setup when you need private targets, a private dashboard, a broader
repository fleet, GitHub App or PAT credentials, or review before any commit,
push, campaign installation, or workflow dispatch.

Create a new private control repository and enter setup directly:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --create-repo --setup
```

For an existing checkout, run:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --setup
```

Setup has three sections:

1. **Repositories:** Enter comma-separated exact `owner/repository` names or
   `*` wildcard patterns. Patterns are expanded before review; only exact names
   are saved.
2. **Connections:** Choose and verify an authentication profile.
3. **Review and apply:** Review the exact scope, credentials, and Pages
   settings. Confirmation defaults to **No**.

Setup offers authentication choices based on that scope and shows each
profile's prerequisites before application.

Guided setup installs no campaign and runs no workflow; it never commits or
pushes. Bare installation also stops without a prompt and prints
`Next: ./cao.sh setup`.

In a headless environment (no interactive terminal, or `CI` set), `--setup`
and `./cao.sh setup` apply a single agent-safe profile without asking for input:

- the control repository must be public;
- existing policy must have no campaigns and no broader scope than the exact
  control repository;
- read and Activity scope remain exactly that repository;
- authentication uses the repository `GITHUB_TOKEN` (`workflow-token`); and
- GitHub Pages must be public and use GitHub Actions as its source.

Setup writes policy only after Pages and the authentication-mode variable
succeed. A private/internal control repository, broader existing scope, or
non-empty campaign map fails closed with interactive-setup guidance.

Use explicit `--quickstart` instead when the desired headless scope is exactly
the documented public sample journey. It accepts a clean public or private
control repository on its default branch and needs no interactive answers.

Headless guided-setup creation must name the exact repository with
`--create-repo OWNER/NAME`. Quickstart is the only exception: it may choose the
signed-in user's `cao` control repository and `cao-sample` target. Because
installer-created control repositories are private, run their guided setup
interactively or run headless setup in an existing public repository. An
outdated installed gh-aw fails with manual-upgrade guidance rather than
prompting, upgrading without consent, or reporting installation success.

Start with **Bug Bash** after a manual setup when you want to review and commit
each stage yourself:

```bash
./cao.sh add githubnext/gh-aw-cao/bug-bash
```

This installs the campaign but does not run it.

After setup, validate and stage only the files you reviewed:

```bash
./cao.sh validate
git diff --check
git status --short
```

See [Control Plane Authentication Profiles](control-plane-authentication.md)
for private organization Apps, enterprise Apps, and fine-grained PATs.

## Installation and recovery

The installer places the production runtime under `.github/`, `activity/`, and
`dashboard/`, plus `cao.sh`, gh-aw's `.gitattributes`, and its
`.vscode/settings.json` project settings. It preserves existing policy in normal
install and setup modes. It refuses existing clone directories and unrelated
files in the quickstart commit.

The runtime must match the exact revision resolved by gh-aw and pass signed
provenance, inventory, and checksum verification. Stable versions use release
assets; main and commit references use successful Actions artifacts retained
for 90 days. If the exact runtime build is already queued or running, the
installer waits for it for up to five minutes. Installation fails closed if the
matching runtime is missing, failed, expired, timed out, or unverifiable.

If quickstart stops after creating either repository, follow the reported
recovery guidance. A failed later phase can leave the public sample repository
in place; inspect or delete it before retrying, or pass it explicitly with
`--target`. Quickstart never reports a dashboard URL until the Activity
snapshot is data-bearing and the corresponding dashboard deployment succeeds.
