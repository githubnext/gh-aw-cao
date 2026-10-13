---
title: CAO Quickstart
description: Use a clean public or private control repository and reach a data-bearing CAO dashboard with one command.
---

Central Agentic Ops (CAO) runs bounded agentic operations from a control
repository. This quickstart can use a clean existing public or private
repository, or create a new private repository. It runs one review-only Bug Bash
against a pinned public target, collects the resulting Activity, and deploys a
public dashboard containing the first data.

**Estimated time: 15-25 minutes**

## Before you start

You need:

- **GitHub account:** Permission to push the selected control repository's
  default branch and configure its GitHub Pages site, or to create a private
  repository.
- **GitHub CLI:** `gh` v2.68.0 or newer. [Install it](https://cli.github.com/)
  and check with `gh --version`.
- **GitHub CLI sign-in:** Check with `gh auth status`; run `gh auth login` if
  needed.
- **Local tools:** Git, Bash, `curl`, and Node.js v24 or newer.
- **GitHub Models access:** The Bug Bash run can consume up to **700 AI
  credits**: 200 for selection and 500 for one investigation.

The quickstart publishes a **public GitHub Pages dashboard**. Its starter
repository, `githubnext/gh-aw-cao`, is public and pinned to an immutable
revision. The starter target is never modified. In a public control repository,
the checked-in policy, workflow runs, dashboard data, and review outputs are
also public. Do not use this path if any resulting evidence must remain
private; use [Guided setup](#guided-setup-instead) in a private control
repository instead.

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

To create a new repository interactively instead, run the same command outside
a Git checkout. Choose the repository owner and accept the suggested `cao`
name, or enter another available name. Installer-created control repositories
remain private.

The explicit `--quickstart` flag authorizes one bounded first-success journey:

1. Install and verify the CAO runtime.
2. Install Bug Bash in `review` mode for only `githubnext/gh-aw-cao`.
3. Configure repository-local `GITHUB_TOKEN` access for public source reads and
   control-repository operations.
4. Configure public GitHub Pages with GitHub Actions as its source.
5. Commit and push only `.github/`, `activity/`, `dashboard/`, `bug-bash/`,
   `cao.sh`, and gh-aw's `.gitattributes` and `.vscode/settings.json`.
6. Dispatch one Bug Bash orchestrator and at most one investigation worker.
7. Collect a CAO Activity snapshot and require at least one collected run.
8. Wait for the data-bearing dashboard deployment and print its URL.

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

## Confirm first success

The command finishes only after the dashboard workflow succeeds and Activity
contains at least one run. Its final summary includes:

```text
CAO quickstart complete.
Dashboard: https://OWNER.github.io/cao/
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
the documented public starter journey. It accepts a clean public or private
control repository on its default branch and needs no interactive answers.

Headless creation must name the exact repository with `--create-repo OWNER/NAME`;
the installer never chooses an owner or repository on your behalf. Because
installer-created repositories are private, run their setup interactively or
run headless setup in an existing public repository. An outdated installed
gh-aw fails with manual-upgrade guidance rather than prompting, upgrading
without consent, or reporting installation success.

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

If quickstart stops after creating the repository, follow the reported recovery
guidance from that checkout. It never reports a dashboard URL until the
Activity snapshot is data-bearing and the corresponding dashboard deployment
succeeds.
