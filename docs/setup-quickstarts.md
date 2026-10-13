---
title: CAO Quickstart
description: Target the shared messy Bug Bash sample and open your first CAO dashboard.
---

Your first Central Agentic Ops (CAO) run targets a shared canonical sample, so
you can see the complete experience without pointing CAO at your own code. One
command pins the sample revision, runs a review-only Bug Bash, and builds your
first data-bearing dashboard.

**Time:** 15-25 minutes
**You get:** a private control repository, a bounded investigation of a public
messy sample with intentional bugs, and a public GitHub Pages dashboard.

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

Then watch CAO:

1. Create private `USERNAME/cao`, your control repository.
2. Select the pinned
   [`githubnext/gh-aw-cao-bug-bash`](https://github.com/githubnext/gh-aw-cao-bug-bash)
   revision. The sample is a deliberately messy change-window coordinator with
   current and legacy code, mixed fallback semantics, team overrides, red
   herrings, and passing but intentionally incomplete tests.
3. Install Bug Bash and run at most one investigation in `review` mode.
4. Collect a CAO Activity snapshot and require at least one collected run.
5. Wait for the data-bearing dashboard deployment.

The command shows progress while GitHub Actions does the longer work.
Quickstart works without a terminal and when `CI` is set.

> [!NOTE]
> Quickstart publishes a public dashboard and can consume up to **700 AI credits**.
> There is no second confirmation: `--quickstart` is your approval
> for control-repository creation when needed, the bounded commit and push, and
> workflow runs.

## 3. Open your dashboard

Quickstart waits for real Activity data and prints a summary like this:

```text
CAO quickstart complete.
Dashboard: https://USERNAME.github.io/cao/
Target: https://github.com/githubnext/gh-aw-cao-bug-bash (canonical messy Bug Bash sample)
Bug Bash: https://github.com/USERNAME/cao/actions/runs/... (success)
Activity: https://github.com/USERNAME/cao/actions/runs/... (... collected runs)
Control repository: https://github.com/USERNAME/cao
```

Open **Dashboard**. You have just run your first CAO campaign.

The canonical sample is designed to produce a reproducible explicit-zero
finding, but every verification gate still applies and `no-finding` remains a
valid successful run. CAO reports missing access or failed workflows as blocked
or failed instead of pretending they succeeded.

CAO configures Pages and repository `GITHUB_TOKEN` access, then commits only
its runtime and policy to the control repository.
The shared starter target is never modified.
Installer-created control repositories remain private.
In a public control repository, policy, workflow runs, dashboard data, and
review outputs are also public.

## Want to use your own public repository?

Replace the shared sample with one exact public target:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart --target OWNER/REPOSITORY
```

CAO still runs in `review` mode and never modifies the target.

## Already have a control repository?

Run the quickstart at the root of a clean public or private
control repository on its default branch. Existing commits are preserved;
staged, unstaged, or untracked changes stop the quickstart before installation.
See the [CAO CLI guide](cao-cli.md) to choose a different control-repository
name.

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
`Next: ./cao.sh setup`.
It offers authentication choices based on that scope and shows each profile's
prerequisites before applying it.

Start with **Bug Bash** after guided setup when you are ready:
`./cao.sh add githubnext/gh-aw-cao/bug-bash`.

See [Control Plane Authentication Profiles](control-plane-authentication.md)
for advanced authentication choices.

## If quickstart stops

- **`USERNAME/cao` already exists:** run quickstart from its clean checkout or
  choose another name with `--create-repo OWNER/NAME`.
- **The canonical sample revision is unavailable:** retry after repository
  access or GitHub availability is restored; quickstart does not fall back to a
  mutable branch.

Quickstart never reports a dashboard URL until Activity contains real run data
and the matching dashboard deployment succeeds.
