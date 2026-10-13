---
title: Set Up CAO
description: Create a control repository, install CAO, and follow the interactive setup.
---

Central Agentic Ops (CAO) runs agentic operations across an explicit repository
fleet from one control repository. By the end of this guide, you will have a
validated control plane with its repository scope and authentication configured.
No campaign runs unless you start it.

**Estimated time: 10-15 minutes**

Before installing, ensure you have:

- **GitHub account:** An account that can create or access the control
  repository, access the repositories you plan to enroll, and manage the
  control repository's Pages settings.
- **GitHub CLI:** `gh` v2.68.0 or newer. [Install it](https://cli.github.com/)
  and check with `gh --version`.
- **Logged in to GitHub CLI:** Verify with `gh auth status` and run
  `gh auth login` if needed.
- **Local tools:** Git, Bash, `curl`, and Node.js v24 or newer. Check Node.js
  with `node --version`.

## 1. Install CAO and Start Setup

Choose one entry point. Neither path commits, pushes, installs an operational
campaign, or runs a workflow.

### New private control repository

From the directory where you want the checkout, create a private control
repository and start guided setup:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --create-repo
```

The installer lists your personal account and organizations where GitHub says
you can create repositories. Use the arrow keys to choose an owner, enter a
repository name, then press Enter when it offers to continue into guided setup.
Follow the printed `cd` command when setup finishes. If `OWNER/cao` is
available, press Enter to accept `cao` as the suggested name. The installer
never creates a public repository and refuses an existing clone directory.

### Existing control repository

Set the existing repository coordinate, then clone it if needed, enter its
checkout, and start guided setup:

```bash
CONTROL_REPOSITORY="OWNER/REPOSITORY"

gh repo clone "$CONTROL_REPOSITORY"
cd "${CONTROL_REPOSITORY#*/}"

curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
```

If the current Git checkout has no GitHub remote, the installer asks whether to
create a private GitHub repository for it. The confirmation defaults to **No**;
if accepted, choose an eligible owner and enter the repository name.
After installation, press Enter when prompted to continue into guided setup.

## 2. Complete Guided Setup

Setup uses keyboard-driven prompts with three visible sections:

1. **Repositories:** Choose which repositories CAO may read. Enter exact
   `owner/repository` names or use `*` wildcards, such as
   `acme*/service-*`. Patterns are expanded, but only exact matched repository
   names are saved.
2. **Connections:** Choose an authentication profile for that scope. Review its
   prerequisites in the
   [authentication profile guide](control-plane-authentication.md).
3. **Review and apply:** Review the exact scope, credentials, and Pages
   settings. Confirmation defaults to **No**. Setup then verifies Pages,
   connects credentials, and saves the policy.

If the dashboard is public, setup asks for separate default-No consent before
changing credentials because published data may include private repository
activity. Restrict dashboard access in **Settings > Pages** when private Pages
is available. Setup installs no campaign and runs no workflow.

## 3. Validate and Save

```bash
./cao.sh validate
git diff --check
git status --short
```

The expected result is a valid policy containing the exact repository scope you
selected.

Review the complete diff before committing. The following command stages every
change under the listed paths, so use it only in a clean checkout. Otherwise,
stage only the setup files you reviewed.

```bash
git add .github activity dashboard cao.sh
git commit -m "Install Central Agentic Ops control plane"
git push --set-upstream origin HEAD
```

## 4. Add Your First Campaign

Start with **Bug Bash**, the smallest complete campaign in the catalog:

```bash
./cao.sh add githubnext/gh-aw-cao/bug-bash
```

Bug Bash investigates one repository in review mode, surfaces at most one
finding, and writes nothing to the investigated repository. Its starter target
is public and pinned to an immutable commit. A first result of `no-finding` is
still a successful run. Model entitlement and AI credits are required; see the
[authentication guide](authentication.md).

To install a different operation instead:

```bash
./cao.sh add githubnext/gh-aw-cao/CAMPAIGN
```

Replace `CAMPAIGN` with a campaign slug from [Browse campaigns](catalog.md).
Read the campaign guide before installing it. Adding a campaign installs its
workflows but does not run them. For manual or non-interactive authentication,
use the detailed [authentication guide](authentication.md).

## Installation Details

The installer adds the production runtime under `.github/`, `activity/`, and
`dashboard/`, plus `cao.sh`. It preserves existing policy and does not include
tests, screenshots, contributor tooling, or the Agent Plugin.

The downloaded runtime must match the exact revision resolved by gh-aw and pass
signed provenance and file-integrity checks before installation. Stable
versions use release assets; main and commit references use successful Actions
artifacts retained for 90 days. Installation stops if the matching runtime is
missing, expired, or unverifiable.

Sign in to `github.com` for catalog artifact and attestation access even when
the control repository uses another GitHub host. Main and commit installations
also need Actions read access to the catalog.

## Alternate Setup and Recovery

Answer **No** at the post-install handoff to finish without opening the wizard,
then run setup later:

```bash
./cao.sh setup
```

Pass `--setup` to the installer to enter guided setup immediately without the
handoff prompt.

Setup requires a bare control plane with no declared campaigns. For a basic
terminal, run `TERM=dumb ./cao.sh setup`. Use `./cao.sh setup --json` to keep a
structured result on stdout, or `./cao.sh setup-auth` for scripted
authentication.

Ctrl-C or declining review cancels before local policy is saved. If setup fails
after changing Pages or credentials, it reports the stopped stage while leaving
local policy unchanged. Fix the reported problem and rerun `./cao.sh setup`.
