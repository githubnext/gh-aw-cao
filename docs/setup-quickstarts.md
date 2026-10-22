---
title: Set Up CAO
description: Set up CAO, monitor one repository, and explore your dashboard before adding automation.
---

Monitor one repository's existing GitHub Agentic Workflow runs, costs, and
outcomes where evidenced.

**Estimated time: 15 minutes**; approval and deployment vary.

**Monitoring only:** no campaign installation or new agentic work.

:::note[Video TODO]
**CAO setup walkthrough — recording not yet available.** Video TODO: demonstrate
install → connect → dashboard. Follow the written steps below.
:::

## Prerequisites

- **Tools:** Git and [GitHub CLI](https://cli.github.com) 2.68+
  on Linux, macOS, or Windows. The curl fallback also requires Bash, curl, and Node.js 24+.
- **Logged in to GitHub CLI:** verify with `gh auth status` and run
  `gh auth login` if needed.
- **One repository to monitor:** choose its exact `OWNER/REPOSITORY`.
  Existing Agentic Workflow history is optional.

Use a **private control repository** for private or internal evidence. A private
repository does **not** guarantee a private Pages site: confirm restricted access
in **Settings → Pages** before publishing non-public evidence. Setup asks before
allowing a public dashboard. This walkthrough uses **GitHub Pages**, not the
separate [hosted server deployment](deployment.md).

## Step 1 - Install CAO

Install the **`gh cao` GitHub CLI extension** with GitHub CLI.
Guided setup prepares missing gh-aw, monitoring runtime, and policy.

:::tip[Installation and authentication]
If authentication fails, sign in and retry:

```bash
gh auth login
gh auth status
```

Sign-in is required for extension installation and control-repository access.
:::

Use a clean default-branch checkout; see
[other topologies](deployment-and-governance.md).

<details>
<summary>No control checkout yet? Explicitly create or clone one.</summary>

Replace `OWNER/CONTROL_REPOSITORY`:

```bash
gh repo create OWNER/CONTROL_REPOSITORY --private --clone
cd CONTROL_REPOSITORY
```

Use `--public` only for public evidence. Guided setup needs no App/PAT for
public targets, including private controls.

To use an existing remote repository instead:

```bash
gh repo clone OWNER/CONTROL_REPOSITORY
cd CONTROL_REPOSITORY
```

</details>

At the control checkout's root:

```bash
gh extension install githubnext/gh-cao
gh cao --version
```

:::tip[SAML-token installation failure]
If extension installation fails because your token lacks cross-organization
SAML authorization, use the curl fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install-gh-cao.sh | bash
```

Requires Bash, curl, and Node.js 24+. Public tool downloads are anonymous;
stored credentials and runtime-provenance access are unchanged.
[Installer details](cao-cli.md#control-plane-installer).
:::

**Ready:** the extension is installed. Existing policy is preserved.
No campaign is added or run.

<span id="guided-setup-instead"></span>

## Step 2 - Connect one repository

In an **interactive terminal** at the **control repository's root**:

```bash
gh cao setup
```

Setup prepares missing runtime and policy, reuses existing installations, and configures scope,
authentication, and Pages. No separate `init` is needed.
See [details](cao-cli.md#guided-runtime-preparation).

1. At **Repositories**, enter your exact `OWNER/REPOSITORY`,
   not an organization wildcard. The control repository stays included.
2. Choose **Authentication** only if prompted. Confirmed public targets
   automatically use `public-only` with Actions' `GITHUB_TOKEN`, no App/PAT,
   even when the control repository is private. Private/internal remote targets require credentials;
   see [Authentication](authentication.md#choose-cross-repository-authentication).
3. Review the exact read scope, output scope, and authentication, then confirm
   **Apply this setup?** Setup configures Pages and asks **Is a public dashboard
   OK?** if the site is public. Decline for non-public evidence.
4. Store secrets in Actions, never in policy or committed files.
   Credentials do not expand scope.
5. Review the one-line change summary; open the full-diff path for details.
   **“Commit and push these CAO monitoring changes? [y/N]”** optionally publishes
   reviewed CAO files and returns **deployment pending** links immediately.

No campaigns or agentic work are installed. Publication requires a synchronized
default branch, matching origin, and empty index; no protection bypass.
Declining, blocked, or unattended setup stays local.

If setup stops, inspect its error, local files, and Pages or credential changes
before retrying; do not publish incomplete setup. For unattended public-only
setup, see [Authentication](authentication.md#public-only-monitoring-quickstart).

<span id="step-3---review-and-publish-your-configuration"></span>

## Step 3 - Publish and open your dashboard

Check installation:

```bash
gh cao doctor
```

If setup published, follow its Actions link. Otherwise review and publish:

```bash
git status --short
git diff -- .github
```

Check that `.github/workflows/cao.json` names only the intended repositories
and that `control-plane.campaigns` is `{}`. Keep `control-plane.workflows` and
`control-plane.operations` absent or `{}` too: monitoring does not enroll
execution. Do not publish private evidence to a public dashboard.

Include only setup-created files, never unrelated files or secrets:

```bash
git add .github activity dashboard
git diff --cached --stat
git commit -m "Set up CAO monitoring"
git push
```

Check **CAO validation** in Actions for full policy and workflow validation.
The installation includes scheduled collection; pushing the policy also triggers
it. This collects evidence, not new agentic work.

<span id="4-open-your-dashboard"></span>
<span id="step-4---wait-for-collection-and-inspect-your-dashboard"></span>

Check **CAO Activity**, then **CAO Dashboard**, including its Pages deployment.
Only then is the dashboard ready. Open its link or **Settings → Pages**.

If collection has not started, request it once from the control checkout:

```bash
gh workflow run cao-activity.yml
```

Activity collects evidence, not new agentic work. Successful collection triggers
dashboard publication. Check Actions for progress instead of dispatching again.

**Ready:** your dashboard opens. Find the repository in **Overview**, open
**Runs**, and follow a run to its evidence. Costs and outcomes appear where available;
missing evidence is not proof of zero cost or success.

**No Agentic Workflow history yet?** An empty dashboard is expected. CAO monitors
GitHub Agentic Workflows, not every ordinary Actions job. No new run is required.
Preview the [sample dashboard](https://githubnext.github.io/gh-cao/cao/), or return
after Activity collects new runs.

## Optional: add automation later

Monitoring is enough. For automation, [derive the simplest suitable structure](operation-patterns.md)
from your outcome and scope.

Try the **[Daily Repo Status quickstart](setup/quickstart.md)** for your first optional
automation: one bounded report in the control repository, without repeating setup.
Other choices include a [Direct operation](authority-envelopes.md) for supplied
targets, a [Standalone fleet workflow](configuration.md#standalone-agentic-workflows)
for bounded inventory selection, a [campaign](https://githubnext.github.io/gh-cao/catalog/) for independent
workers, or ordinary GitHub Actions for deterministic work and approvals.

None is enrolled, enabled or run by setup. Installation is not execution:
review and commit workflows and policy together before enabling them. Start in
**review** mode with **one repository**; model access and AI credits are separate
prerequisites. See [Roll out a campaign](rollout-and-routing.md).

The [Repo Assist walkthrough](repo-assist-quickstart.md) demonstrates a review-only campaign.

## Continue learning

- [Explore the dashboard](dashboard.md).
- [Configuration](configuration.md): understand your policy.
