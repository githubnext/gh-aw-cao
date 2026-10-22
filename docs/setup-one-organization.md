---
title: Set Up One Organization
description: Install a CAO control plane for private repositories in one organization using private GitHub Apps.
---

You need an approved private App pair and authorized access to its keys, or
permission to create and install private Apps for the organization. Repository
administrators can extend an approved installation to their repositories where
organization policy permits; new installations still need appropriate approval.

> [!IMPORTANT]
> Permission does not authorize setup. A coding agent must ask before creating or reusing the control repository, installing the extension/runtime, creating either App, storing variables or secrets, committing, or pushing.

## Install

```bash
CONTROL_REPO="acme/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh auth status
```

Enter an existing clean default-branch control checkout. To create a new
repository instead, choose its visibility explicitly:

```bash
gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash
gh cao setup
```

To reuse a remote repository, use `gh repo clone "$CONTROL_REPO"` instead of
creating one. In an existing checkout, run the installer and then `gh cao setup`.
The installer requires Bash, curl, and Node.js 24+ and anonymously installs
public gh-aw and gh-cao releases without changing stored credentials.
No separate `init` is required. See the [primary setup guide](setup-quickstarts.md).

At **Repositories**, enter the exact value of `$TARGET_REPO`; the control
repository stays included. Choose **`github-app`** when authentication is
prompted. Setup prepares Activity, Dashboard, validation, shared runtime and
missing baseline policy, then configures scoped authentication and Pages.
A private repository does not guarantee private Pages: require restricted
access for non-public evidence and decline public publication otherwise.

## Configure the Apps

If Apps are already approved, prefer
[reusing their client IDs](authentication.md#reuse-approved-apps)
with `--read-client-id` and `--write-client-id`, or choose **`approved-app`**
in guided setup. Keys are entered only at hidden prompts.
Otherwise create a pair through the guided prompts.
For credential-only changes after setup, inspect a dry run before applying:

```bash
gh cao setup auth github-app \
  --repo "$CONTROL_REPO" \
  --dry-run

gh cao setup auth github-app \
  --repo "$CONTROL_REPO"
```

For both browser flows:

1. Keep the App private.
2. Choose **Only select repositories**.
3. Select only the repositories printed in the terminal.
4. Finish the installation and return to the terminal.

Setup verifies the exact selected repository membership with a short-lived App
installation token and does not accept a manual-verification fallback. The
write App defaults to the control repository so review outputs have an approved
destination. Ensure every dispatched worker admits the write App's
`APP-SLUG[bot]` login.

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

Credential setup is complete when the policy parses, exact App installation
membership is verified, the expected App variables and secrets exist, and
`gh aw doctor` reports no blocking installation error. Before live activation,
complete the current-revision dashboard, review, and live checks in
[Validate before activation](control-plane-authentication.md#validate-before-activation).

## Next: Add a Campaign

Campaign selection, installation, enablement, and the first review run are a separate change. Use [Browse campaigns](catalog.md) or ask an agent to follow `skills/add-cao-campaign/SKILL.md`.
