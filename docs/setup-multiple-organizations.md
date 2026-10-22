---
title: Set Up Multiple Organizations
description: Install a CAO control plane across organizations using enterprise-owned private GitHub Apps.
---

You need permission to create enterprise GitHub Apps and install them separately on every enrolled organization.

> [!IMPORTANT]
> Permission does not authorize setup. A coding agent must ask before creating or reusing the control repository, installing the extension/runtime, creating either App, storing variables or secrets, committing, or pushing.

## Install

```bash
CONTROL_REPO="platform/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh auth status
```

Enter an existing clean default-branch control checkout. To create a new
repository instead, choose visibility explicitly:

```bash
gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash
```

To reuse a remote repository, use `gh repo clone "$CONTROL_REPO"` instead of
creating one, then run the installer from its root. Prepare the approved App pair
below before running guided setup. The installer requires Bash, curl, and Node.js
24+ and anonymously installs public gh-aw and gh-cao releases without changing
stored credentials. No separate `init` is required.
See the [primary setup guide](setup-quickstarts.md).

## Create and Install the Apps

In enterprise settings:

1. Create one private read App and one private write App.
2. Use the [CAO permission matrix](authentication.md#permissions).
3. Install each App separately on every enrolled organization.
4. Choose **Only select repositories** for every installation.
5. Record both client IDs and download one private key for each App.

Enterprise ownership alone grants no repository access.

## Configure the Control Repository

From the control checkout:

```bash
gh cao setup
```

At **Repositories**, enter the exact value of `$TARGET_REPO`; the control
repository stays included. Choose **`enterprise-app`** when prompted.
Guided setup accepts the approved App client IDs, prompts securely for keys and
verifies that all repositories belong to the same enterprise.
Setup prepares Activity, Dashboard, validation, shared runtime and missing
baseline policy, then configures scoped authentication and Pages.
A private repository does not guarantee private Pages: require restricted
access for non-public evidence and decline public publication otherwise.

For credential-only changes after setup, inspect a dry run before applying:

```bash
gh cao setup auth enterprise-app \
  --repo "$CONTROL_REPO" \
  --read-client-id "<read-app-client-id>" \
  --write-client-id "<write-app-client-id>" \
  --policy .github/workflows/cao.json \
  --write-repository "$CONTROL_REPO" \
  --dry-run

gh cao setup auth enterprise-app \
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

If an App installation or exact repository selection is missing, correct the
installation instead of widening policy. Before live activation, complete the
current-revision dashboard, review, and live checks in
[Validate before activation](control-plane-authentication.md#validate-before-activation).

## Next: Add a Campaign

Campaign selection, installation, enablement, and the first review run are a separate change. Use [Browse campaigns](catalog.md) or ask an agent to follow `skills/add-cao-campaign/SKILL.md`.
