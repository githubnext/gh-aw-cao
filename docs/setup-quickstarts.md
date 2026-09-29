---
title: Set Up CAO
description: Create one control repository, install CAO, and follow the interactive setup.
---

## 1. Open the Control Repository

Use a private repository unless every target and all future operational data may be public.

You need GitHub CLI (`gh`), Git, Bash, `curl`, and Node.js 24 or newer. Use a
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

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash

./cao.sh setup
```

The setup command:

1. asks which repositories CAO should read;
2. checks their visibility and owners;
3. offers authentication choices based on that scope; verify each profile's
   prerequisites in the [authentication profile guide](control-plane-authentication.md);
4. shows the exact plan before changing policy, credentials, or Pages settings;
5. configures the control repository's Pages source as GitHub Actions and, for a private repository, restricts the site to repository readers (requires Pages access control support and permission to manage Pages settings);
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
