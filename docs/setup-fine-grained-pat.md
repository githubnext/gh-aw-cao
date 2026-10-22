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
```

Enter an existing clean default-branch control checkout. To create a new
repository instead, choose visibility explicitly:

```bash
gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install-gh-cao.sh | bash
gh cao setup
```

To reuse a remote repository, use `gh repo clone "$CONTROL_REPO"` instead of
creating one. In an existing checkout, run the installer and then `gh cao setup`.
The installer requires Bash, curl, and Node.js 24+ and anonymously installs
public gh-aw and gh-cao releases without changing stored credentials.
No separate `init` is required. See the [primary setup guide](setup-quickstarts.md).

At **Repositories**, enter the exact value of `$TARGET_REPO`; the control
repository stays included. Choose **`token`** when prompted.
Setup prepares Activity, Dashboard, validation, shared runtime and missing
baseline policy, then guides scoped token creation and Pages.
A private repository does not guarantee private Pages: require restricted
access for non-public evidence and decline public publication otherwise.

## Configure the Tokens

Guided setup shows each owner-scoped token plan before requesting a secret.
For credential-only changes after setup, inspect a dry run before applying:

```bash
gh cao setup auth token \
  --repo "$CONTROL_REPO" \
  --write-repository "$CONTROL_REPO" \
  --expires-in 30 \
  --dry-run

gh cao setup auth token \
  --repo "$CONTROL_REPO" \
  --write-repository "$CONTROL_REPO" \
  --expires-in 30
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
gh cao doctor
gh aw doctor --repo "$CONTROL_REPO" --dir .
git diff --check
```

Initial guided setup separately offers **“Commit and push these CAO monitoring
changes? [y/N]”** after review. Approval requires a synchronized default branch,
matching origin and empty index. It publishes only reviewed CAO files and
returns deployment-pending links immediately, without waiting for Actions.
Declining, blocked publication, or unattended setup leaves files local.

If not published, review the diff and stage only CAO files. The following assumes
these paths contain no unrelated edits. After explicit approval:

```bash
git add .github activity dashboard
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
