---
title: Set Up CAO
description: Create one control repository, install CAO, and follow the interactive setup.
---

## 1. Check Prerequisites

Use a private repository unless every target and all future operational data may be public.

You need GitHub CLI (`gh`) with `gh attestation verify` support (including
`--source-digest` and `--signer-digest`), Git, Bash, `curl`, and Node.js 24 or
newer. Normal installation does not need npm. Use a
GitHub CLI account that can access the control repository and the repositories
you plan to enroll. If you are not signed in, run `gh auth login` (add
`--hostname HOST` for a non-default GitHub host), then confirm your session:

```bash
gh auth status
```

## 2. Install and Set Up

Choose one entry point. Neither commits, pushes, installs an operational
campaign, or dispatches a workflow.

### New private control repository

From the directory where you want the checkout, create a private repository,
install CAO into its clone, and open guided setup in one command:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --create-repo OWNER/CONTROL_REPOSITORY --setup
```

`--create-repo` explicitly authorizes repository creation. The installer checks
tools and sign-in first, refuses an existing clone directory, and never creates
a public repository. After it finishes, open the printed checkout directory:

```bash
cd CONTROL_REPOSITORY
```

### Existing control repository

Open a terminal at the checkout's root. Clone it first if needed:

```bash
gh repo clone OWNER/CONTROL_REPOSITORY
cd CONTROL_REPOSITORY
```

Install and enter guided setup:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --setup
```

Replace uppercase placeholders with your values. `CONTROL_REPOSITORY` is the
repository name without its owner in the `cd` command. Omitting `--setup`
installs without opening the wizard; run `./cao.sh setup` later. Both paths
preserve existing policy. Setup itself requires a bare control plane with
no declared campaigns, not an already enrolled fleet.

### What gets installed

The installer adds a curated production runtime under `.github/`, `activity/`,
and `dashboard/`, plus `cao.sh`. It does not copy dashboard tests, screenshots,
contributor tooling, or the Agent Plugin. Install the plugin separately in your
agent client when you want portable skills or the Canvas integration.

The runtime is built before installation, not packed on your machine. Stable
version references download release assets; main/SHA references download
successful Actions build artifacts retained for 90 days. Both must match the
exact revision resolved by gh-aw and pass signed provenance and file checks.
Sign in to `github.com` for catalog artifact and attestation access, even if
your control repository uses another GitHub host. Main/SHA installs also need
Actions read access to the catalog. If that build is still running, missing,
expired, or unverifiable, installation stops: wait for the build or choose a
published version rather than substituting another runtime revision. Dashboard
builds still install their existing production npm dependencies.

### Guided setup

Setup uses keyboard-driven prompts with three visible sections:

1. **Repositories:** choose which repositories CAO should read; enter exact `owner/repository`
   names or `*` wildcards in either component (for example, `acme*/service-*`
   or `*/service-*`); `*` means `*/*`. Patterns expand against your accessible
   organizations; only exact matched names are saved. The control repository
   remains included, and visibility is checked.
2. **Connections:** setup offers authentication choices based on that scope.
   Select with the arrow keys and verify the selected profile's
   prerequisites in the
   [authentication profile guide](control-plane-authentication.md).
3. **Review and apply:** review the exact scope, credential profile, and Pages
   settings. Confirmation defaults to **No**. After confirmation, setup
   configures and verifies the Pages source, checks dashboard visibility,
   connects credentials, and atomically
   saves policy. It installs no campaign and runs no workflow.

Setup requires permission to manage Pages settings and preserves the site's
visibility. If the dashboard is public, a separate **default-No** confirmation
warns that anyone can read published data, including private repository
activity. Consent is required **before changing credentials**. Declining or
Ctrl-C at that question removes a site that setup just created, when possible;
an existing site is left in place with instructions to restrict or unpublish
it. To make Pages private, restrict access in **Settings > Pages** (requires an
organization on GitHub Enterprise Cloud).

Invalid repository input stays in the prompt so you can correct it. Ctrl-C or
declining review cancels without applying setup. Failures after application
starts report the stopped stage: local policy remains unchanged, but Pages
settings or credentials may already have changed. Fix the reported problem and
rerun `./cao.sh setup`; external changes are not presented as transactional.

For a basic terminal, use `TERM=dumb ./cao.sh setup` for numbered, plain-text
prompts. Setup requires an interactive terminal; use `./cao.sh setup-auth` for
scripted authentication. `./cao.sh setup --json` retains a structured result on
stdout while prompts remain on stderr. The prompt library is bundled into the
verified runtime; operators still do not run npm.

## 3. Validate, Review, and Save

```bash
./cao.sh validate
git diff --check
git status --short
```

Validation checks the installed control plane; the expected result is a valid
policy with the exact repository scope you selected. Setup installs no
user-facing campaign and runs no workflow.

Review the complete status and diff before committing. The following command
stages every change under these paths, so use it only in a clean checkout. If
you are reusing a repository with other work, stage only the setup files you
reviewed.

```bash
git add .github activity dashboard cao.sh
git commit -m "Install Central Agentic Ops control plane"
git push --set-upstream origin HEAD
```

## Next: Add a Campaign

Start with **Bug Bash**. It is the smallest complete campaign in the catalog and
the recommended way to see the control plane work end to end:

```bash
./cao.sh add githubnext/gh-aw-cao/bug-bash
```

Bug Bash promises one thing — *find a bug you can reproduce, review a fix you can
understand* — and keeps the first run bounded: one repository, one investigation,
at most one surfaced finding, review mode only, no schedule, and nothing written
to the investigated repository. Its starter target is a public repository pinned
to an immutable commit, so no additional GitHub credentials are required, and a
first run that reports `no-finding` is a success. Model entitlement and AI
credits are still consumed; see the [authentication guide](authentication.md).

To install a different operation instead:

```bash
./cao.sh add githubnext/gh-aw-cao/CAMPAIGN
```

Replace `CAMPAIGN` with a campaign slug from [Browse campaigns](catalog.md).
Read the campaign guide before installing it. Adding a campaign installs its
workflows but does not run them. For manual or non-interactive authentication,
use the detailed [authentication guide](authentication.md).
