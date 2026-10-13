---
title: CAO Quickstart
description: Create a private control repository and reach a data-bearing CAO dashboard with one command.
---

Central Agentic Ops (CAO) runs bounded agentic operations from a private
control repository. This quickstart creates that repository, runs one
review-only Bug Bash against a pinned public target, collects the resulting
Activity, and deploys a public dashboard containing the first data.

**Estimated time: 15-25 minutes**

## Before you start

You need:

- **GitHub account:** Permission to create a private repository and GitHub
  Pages site.
- **GitHub CLI:** `gh` v2.68.0 or newer. [Install it](https://cli.github.com/)
  and check with `gh --version`.
- **GitHub CLI sign-in:** Check with `gh auth status`; run `gh auth login` if
  needed.
- **Local tools:** Git, Bash, `curl`, and Node.js v24 or newer.
- **GitHub Models access:** The Bug Bash run can consume up to **700 AI
  credits**: 200 for selection and 500 for one investigation.

The quickstart publishes a **public GitHub Pages dashboard**. Its starter
repository, `githubnext/gh-aw-cao`, is public and pinned to an immutable
revision. Review outputs remain in your private control repository and the
starter target is never modified. Do not use this path if the resulting
dashboard data must remain private; use [Guided setup](#guided-setup-instead)
instead.

## Run the quickstart

From the directory where you want the new checkout:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart
```

Choose the repository owner and accept the suggested `cao` name, or enter
another available name. The quickstart creates a private repository; it never
creates a public control repository.

The explicit `--quickstart` flag authorizes one bounded first-success journey:

1. Install and verify the CAO runtime.
2. Install Bug Bash in `review` mode for only `githubnext/gh-aw-cao`.
3. Configure repository-local `GITHUB_TOKEN` access for public source reads and
   control-repository operations.
4. Configure public GitHub Pages with GitHub Actions as its source.
5. Commit and push only `.github/`, `activity/`, `dashboard/`, `bug-bash/`, and
   `cao.sh`.
6. Dispatch one Bug Bash orchestrator and at most one investigation worker.
7. Collect a CAO Activity snapshot and require at least one collected run.
8. Wait for the data-bearing dashboard deployment and print its URL.

The local installation phases show elapsed progress and should finish well
before the GitHub Actions work. Most of the estimated time is the bounded Bug
Bash investigation, Activity collection, and dashboard deployment running on
GitHub; the quickstart keeps the active phase and elapsed time visible.

There is no second confirmation after repository creation: `--quickstart` is
the explicit authorization for these effects. A `no-finding` Bug Bash result is
still successful. Missing model entitlement, missing permissions, workflow
failure, or an empty Activity artifact is reported as blocked or failed rather
than as success.

For non-interactive repository creation, provide the exact coordinate:

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
`no-finding` result, remains in the private control repository.

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
`dashboard/`, plus `cao.sh`. It preserves existing policy in normal install and
setup modes. It refuses existing clone directories and unrelated files in the
quickstart commit.

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
