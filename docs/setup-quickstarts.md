---
title: Set Up CAO
description: Create one control repository, install CAO, and follow the interactive setup.
---

## 1. Open the Control Repository

Use a private repository unless every target and all future operational data may be public.

Create one when needed:

```bash
gh auth status
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

## 3. Review and Save

```bash
git diff --check
git status --short
```

After reviewing the generated control plane:

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
For manual or non-interactive authentication, use the detailed
[authentication guide](authentication.md).
