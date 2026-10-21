---
title: Set Up CAO
description: Set up CAO, monitor one repository, and explore your dashboard before adding automation.
---

This guide walks you through installing CAO in a control repository, connecting
one repository to monitor, and publishing a dashboard of its existing GitHub
Agentic Workflow runs, costs, and outcomes.

This setup is for monitoring only. You can add an agentic workflow or a campaign
later if you choose.

## Prerequisites

- You need **Git**, **Bash**, **`curl`**, **Node.js 24+**, and **GitHub CLI 2.68+**.
- Run **`gh auth login`** if needed.
- You need permission to configure **Actions**, **credentials**, and
  **Pages** in your control repository.
- CAO lives in a **control repository** that stores its configuration
  and runs collection. Prefer a separate repository; the repository you monitor
  does not need CAO installed in it.
- Use a **private control repository** for private or internal evidence.
  **Dashboard visibility** is a separate choice: a private repository does **not**
  guarantee a private Pages site. Setup checks this and asks before allowing
  public publication.

## 1. Install CAO

From a clean checkout of your chosen control repository, on its default branch:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash
```

**Ready:** the CAO runtime, Activity collector, and dashboard workflows are
installed locally. No campaign is installed or run.

<details>
<summary>Need a new control repository?</summary>

Run this outside a Git checkout, replacing `OWNER/CONTROL_REPOSITORY` with the
exact repository you want to create:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh |
  bash -s -- --create-repo OWNER/CONTROL_REPOSITORY
```

The installer creates and clones a private repository. Enter the directory it
prints before continuing.

</details>

<span id="guided-setup-instead"></span>

## 2. Connect one repository

```bash
gh cao setup
```

Follow **Repositories → Connections → Review and apply**:

1. Enter the exact `OWNER/REPOSITORY` you want to monitor, not an organization
   wildcard. The control repository stays included in scope.
2. Connect authentication. Setup offers authentication choices based on that scope;
   check the selected profile's prerequisites before approving.
3. Review the repository list, credentials, and dashboard visibility, then apply.

**Ready:** repository scope and authentication are configured.
Setup installs no campaign and runs no workflow; it does not commit or push.
The campaign map in `.github/workflows/cao.json` should remain empty.

Need help choosing credentials? See [Authentication](authentication.md).
Run setup in an interactive terminal for this guided path; headless setup only
supports the exact current public control repository, not an external target.

## 3. Publish your configuration

Check the installation and inspect the installed files:

```bash
gh cao doctor
git status --short
git diff -- .github
```

Check that `.github/workflows/cao.json` names only the intended repositories
and that `control-plane.campaigns` is `{}`. Do not publish private evidence to a
public dashboard.

Commit the CAO files and push to the control repository's default branch:

```bash
git add .github activity dashboard
git commit -m "Set up CAO monitoring"
git push
```

**Ready:** GitHub Actions can use your reviewed configuration.
Check **CAO validation** in Actions for full policy and workflow validation.
The installation includes scheduled Activity collection; pushing the policy
also triggers collection. This collects evidence, not new agentic work.

## 4. Open your dashboard

In the control repository's **Actions** tab, wait for **CAO Activity** and then
**CAO Dashboard** to complete, including its Pages deployment.
Open the site link in **Settings → Pages**.

If collection has not started, request it once from the control checkout:

```bash
gh workflow run cao-activity.yml
```

Activity refreshes the evidence; it does not run the workflows you monitor.
Successful collection triggers dashboard publication automatically. Check the
Actions runs for progress rather than repeatedly dispatching collection.

**Your first look:** find the repository in **Overview**, open **Runs**, and
follow a run back to its evidence. Costs and outcomes appear where available;
missing evidence is not proof of zero cost or success.

**No Agentic Workflow history yet?** An empty dashboard is expected. CAO monitors
GitHub Agentic Workflows, not every ordinary Actions job. You can finish setup
without generating a run. Preview the
[sample dashboard](https://githubnext.github.io/gh-cao/cao/) to see populated
views, or return after your existing workflows have run and Activity has refreshed.

## Optional: add automation later

Want a first report rather than a code change? The
[Repo Status quickstart](setup/quickstart.md) installs a cross-repository
campaign and walks through one bounded review run. Its CAO-specific video
recording is not yet available; the written steps are complete.

Monitoring is enough to get started. When you have a task you want CAO to perform,
browse the [campaign catalog](https://githubnext.github.io/gh-cao/catalog/).
Install a chosen campaign with:

```bash
gh cao campaigns add githubnext/gh-cao/CAMPAIGN
```

Installation is not execution. Review and commit its workflows and policy
together before enabling or running it. Start in **review** mode with **one
repository**; model access and AI credits are separate prerequisites.
See [Roll out a campaign](rollout-and-routing.md) for the execution steps.

Want a manual campaign example instead? The separate
[Repo Assist walkthrough](repo-assist-quickstart.md) starts from a configured control
repository and shows how to request one review-only maintenance proposal. It is optional,
not a prerequisite for monitoring.
