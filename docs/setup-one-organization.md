---
title: Set Up One Organization
description: Install a CAO control plane for private repositories in one organization using private GitHub Apps.
---

You need permission to create and install private GitHub Apps for the organization.

> [!IMPORTANT]
> Permission does not authorize setup. A coding agent must ask before creating or reusing the control repository, running the installer, creating either App, storing variables or secrets, committing, or pushing.

## Install

```bash
CONTROL_REPO="acme/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh auth status
gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"

curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
```

In `.github/workflows/cao.json`, add only the exact first target:

```json
"scope": {
  "allowed-owners": ["acme"],
  "allowed-repositories": ["acme/example-service"]
}
```

## Configure the Apps

```bash
./cao.sh setup-auth github-app \
  --repo "$CONTROL_REPO" \
  --dry-run

./cao.sh setup-auth github-app \
  --repo "$CONTROL_REPO"
```

For both browser flows:

1. Keep the App private.
2. Choose **Only select repositories**.
3. Select only the repositories printed in the terminal.
4. Finish the installation and return to the terminal.

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

Setup is complete when the policy parses, the expected App variables and secrets exist, and `gh aw doctor` reports no blocking installation error.

## Next: Add a Campaign

Campaign selection, installation, enablement, and the first review run are a separate change. Use [Browse campaigns](catalog.md) or ask an agent to follow `skills/add-cao-campaign/SKILL.md`.
