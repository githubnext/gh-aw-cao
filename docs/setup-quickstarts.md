---
title: Set Up CAO
description: Create one control repository, install CAO, and follow the interactive setup.
---

## 1. Open the Control Repository

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

If you already have a **empty** local control-repository checkout, open a terminal at its
root. Otherwise, clone an existing repository:

```bash
gh repo clone OWNER/CONTROL_REPOSITORY
cd CONTROL_REPOSITORY
```

Create one when needed:

```bash
gh repo create OWNER/CONTROL_REPOSITORY --private --clone
cd CONTROL_REPOSITORY
```

Replace uppercase placeholders with your values. `CONTROL_REPOSITORY` is the
repository name without its owner in the `cd` command.

## 2. Install and Set Up

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

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash

./cao.sh setup
```

The setup command:

1. asks which repositories CAO should read; enter exact `owner/repository`
   names or `*` wildcards in either component (for example, `acme*/service-*`
   or `*/service-*`); `*` means `*/*`;
2. expands patterns against your accessible organization list and saves only
   exact matched repositories in policy, then checks visibility and owners;
3. offers authentication choices based on that scope; verify each profile's
   prerequisites in the [authentication profile guide](control-plane-authentication.md);
4. shows the exact plan before changing policy, credentials, or Pages settings;
5. configures the control repository's Pages source as GitHub Actions (requires permission to manage Pages settings) without changing the site's visibility. If the site is public, setup warns that anyone can read the published dashboard and asks whether that is OK; declining removes a site that setup just created and leaves policy and credentials unchanged. To keep it private, restrict access in **Settings > Pages** (requires an organization on GitHub Enterprise Cloud);
6. installs no campaign and runs no workflow.

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

Choose and install the first operation as a separate change:

```bash
./cao.sh add githubnext/gh-aw-cao/CAMPAIGN
```

Replace `CAMPAIGN` with a campaign slug from [Browse campaigns](catalog.md).
Read the campaign guide before installing it. Adding a campaign installs its
workflows but does not run them. For manual or non-interactive authentication,
use the detailed [authentication guide](authentication.md).
