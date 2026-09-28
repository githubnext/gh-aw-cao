---
title: Set Up Multiple Organizations
description: Install a CAO control plane across organizations using enterprise-owned private GitHub Apps.
---

You need permission to create enterprise GitHub Apps and install them separately on every enrolled organization.

> [!IMPORTANT]
> Permission does not authorize setup. A coding agent must ask before creating or reusing the control repository, running the installer, creating either App, storing variables or secrets, committing, or pushing.

## Install

```bash
CONTROL_REPO="platform/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh auth status
gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"

curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
```

In `.github/workflows/cao.json`, add only the required owners and exact repositories:

```json
"scope": {
  "allowed-owners": ["platform", "acme"],
  "allowed-repositories": [
    "acme/example-service"
  ]
}
```

## Create and Install the Apps

In enterprise settings:

1. Create one private read App and one private write App.
2. Use the [CAO permission matrix](authentication.md#permissions).
3. Install each App separately on every enrolled organization.
4. Choose **Only select repositories** for every installation.
5. Record both client IDs and download one private key for each App.

Enterprise ownership alone grants no repository access.

## Configure the Control Repository

```bash
./cao.sh setup-auth enterprise-app \
  --repo "$CONTROL_REPO" \
  --read-client-id "<read-app-client-id>" \
  --write-client-id "<write-app-client-id>" \
  --policy .github/workflows/cao.json \
  --write-repository "$CONTROL_REPO" \
  --dry-run

./cao.sh setup-auth enterprise-app \
  --repo "$CONTROL_REPO" \
  --read-client-id "<read-app-client-id>" \
  --write-client-id "<write-app-client-id>" \
  --policy .github/workflows/cao.json \
  --write-repository "$CONTROL_REPO"
```

Paste private keys only into the secure prompts.

The read App must cover the control repository and every exact repository in
the policy. The write App must cover the control repository for review output;
repeat `--write-repository` only for additional approved output repositories.
Ensure every dispatched worker admits the write App's `APP-SLUG[bot]` login.

## Validate and Commit

```bash
node -e \
  'const fs=require("node:fs"); JSON.parse(fs.readFileSync(".github/workflows/cao.json","utf8"))'
gh aw doctor --repo "$CONTROL_REPO" --dir .
git diff --check
```

Review the diff. After explicit approval:

```bash
git add .github activity dashboard cao.sh
git commit -m "Install Central Agentic Ops control plane"
git push --set-upstream origin HEAD
```

If an App installation or exact repository selection is missing, correct the
installation instead of widening policy. Before live activation, complete the
current-revision dashboard, review, and live checks in
[Validate before activation](control-plane-authentication.md#validate-before-activation).

## Next: Add a Campaign

Campaign selection, installation, enablement, and the first review run are a separate change. Use [Browse campaigns](catalog.md) or ask an agent to follow `skills/add-cao-campaign/SKILL.md`.
