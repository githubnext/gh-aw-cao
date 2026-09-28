---
title: Set Up with Fine-Grained PATs
description: Install a CAO control plane with separate owner-scoped tokens when your repository scope and permissions require them.
---

Use this path when you cannot install a suitable GitHub App and:

- you already have access to every exact repository;
- organization policy permits fine-grained PATs;
- every required campaign API supports fine-grained PATs;
- you can create a separate token for each resource owner;
- you accept manual expiration, rotation, and revocation.

Never use a classic PAT.

> [!IMPORTANT]
> Existing repository access does not authorize token setup. A coding agent must show the dry-run plan and ask before opening PAT creation pages, storing tokens or repository maps, committing, or pushing.

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

In `.github/workflows/cao.json`, add only the required owners and exact repositories:

```json
"scope": {
  "allowed-owners": ["acme"],
  "allowed-repositories": ["acme/example-service"]
}
```

## Configure the Tokens

```bash
./cao.sh setup-auth token \
  --repo "$CONTROL_REPO" \
  --write-repository "$CONTROL_REPO" \
  --expires-in 30 \
  --dry-run

./cao.sh setup-auth token \
  --repo "$CONTROL_REPO" \
  --write-repository "$CONTROL_REPO" \
  --expires-in 30 \
  --acknowledge-token-risks
```

For every browser form:

1. Confirm the displayed **Resource owner**.
2. Keep **Repository access** set to **Only select repositories**.
3. Select only the repositories printed in the terminal.
4. Keep the preselected permissions unchanged.
5. Generate the token and paste it only into the matching secure prompt.

The command groups repositories by resource owner and stores owner-scoped secrets plus non-secret repository maps.

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

Credential setup is complete when the policy parses, the owner-scoped secret
maps match the exact repositories, and `gh aw doctor` reports no blocking
installation error. Before live activation, complete the current-revision
dashboard, review, and live checks in
[Validate before activation](control-plane-authentication.md#validate-before-activation).

## Next: Add a Campaign

Campaign selection, installation, enablement, and the first review run are a separate change. Use [Browse campaigns](catalog.md) or ask an agent to follow `skills/add-cao-campaign/SKILL.md`.
