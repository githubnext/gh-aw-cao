---
title: Set Up Multiple Organizations
description: Install a CAO control plane across organizations using enterprise-owned private GitHub Apps.
---

For non-public targets, reuse approved enterprise-owned private Apps within one
enterprise, or create them with the required approval and install them separately
on every enrolled organization. A permitted [owner-scoped PAT setup](setup-fine-grained-pat.md)
is another option. Public-only monitoring needs no automation App/PAT.
See [setup combinations](setup-compatibility.md) for visibility and role boundaries,
including GitHub Enterprise Cloud data residency on `*.ghe.com`.

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
gh extension install githubnext/gh-cao
```

To reuse a remote repository, use `gh repo clone "$CONTROL_REPO"` instead of
creating one, then install the extension. Prepare the approved App pair
below before running guided setup. No separate `init` is required.
See the [primary setup guide](setup-quickstarts.md).

:::tip[SAML-token installation failure]
If GitHub CLI cannot install the extension because of cross-organization SAML
authorization, use the [curl fallback](cao-cli.md#control-plane-installer):
`curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install-gh-cao.sh | bash`.
It requires Bash, curl, and Node.js 24+ and preserves stored credentials.
:::

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
Guided setup accepts the approved App client IDs and prompts securely for keys.
Verify independently that all selected organizations belong to the same
enterprise and that both Apps have the required selected-repository
installations. The legacy `enterprise-app` path stores credentials; it does not
prove enterprise membership or installation reach. Prefer
[verified approved-App reuse](authentication.md#reuse-approved-apps) when
connecting existing Apps.
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
