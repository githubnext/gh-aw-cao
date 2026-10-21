---
title: Set Up CAO
description: Set up CAO, monitor one repository, and explore your dashboard before adding automation.
---

By the end of this guide, you will have CAO monitoring one repository and a
dashboard of its existing GitHub Agentic Workflow runs, costs, and outcomes.

**Estimated time: 15 minutes**, plus credential approval and Actions deployment time.

This guide sets up **monitoring only**. It does not install or run a campaign
or start new agentic work.

:::note[Video TODO]
Record a CAO setup demonstration: install, connect one repository, review the
configuration, and open the dashboard. A recording is not yet available;
follow the written steps below.
:::

## Prerequisites

- You need **Git**, **Bash**, **`curl`**, **Node.js 24+**, and **GitHub CLI 2.68+**.
- Verify your login with **`gh auth status`**; run **`gh auth login`** if needed.
- You need permission to configure **Actions**, **credentials**, and
  **Pages** in your control repository.
- CAO lives in a **control repository** that stores its configuration
  and runs collection. Prefer a separate repository; the repository you monitor
  does not need CAO installed in it.
- Use a **private control repository** for private or internal evidence.
  **Dashboard visibility** is a separate choice: a private repository does **not**
  guarantee a private Pages site. Setup checks this and asks before allowing
  public publication.

## Step 1 - Install CAO

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

## Step 2 - Connect one repository

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

## Step 3 - Review and publish your configuration

Check the installation and inspect the installed files:

```bash
gh cao doctor
git status --short
git diff -- .github
```

Check that `.github/workflows/cao.json` names only the intended repositories
and that `control-plane.campaigns` is `{}`. Keep `control-plane.workflows` and
`control-plane.operations` absent or `{}` too: monitoring does not enroll
execution. Do not publish private evidence to a public dashboard.

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

<span id="4-open-your-dashboard"></span>

## Step 4 - Wait for collection and inspect your dashboard

In the control repository's **Actions** tab, wait for **CAO Activity** and then
**CAO Dashboard** to complete, including its Pages deployment.
Open the site link in **Settings → Pages**.

If collection has not started, request it once from the control checkout:

```bash
gh workflow run cao-activity.yml
```

Activity collects evidence, not new agentic work. Successful collection triggers
dashboard publication. Check Actions for progress instead of dispatching again.

**Your first look:** find the repository in **Overview**, open **Runs**, and
follow a run back to its evidence. Costs and outcomes appear where available;
missing evidence is not proof of zero cost or success.

**No Agentic Workflow history yet?** An empty dashboard is expected. CAO monitors
GitHub Agentic Workflows, not every ordinary Actions job. You can finish setup
without generating a run. Preview the
[sample dashboard](https://githubnext.github.io/gh-cao/cao/) to see populated
views, or return after your existing workflows have run and Activity has refreshed.

## Optional: add automation later

Monitoring is enough. For execution, describe your outcome and scope;
[derive the simplest suitable structure](operation-patterns.md) rather than
starting with a pattern name.

| Your requirements | Derived structure and reference |
| --- | --- |
| Visibility without changing execution | Observe only; setup is complete. |
| Supplied exact targets, one bounded mission | [Direct operation](authority-envelopes.md), without discovery. |
| CAO selects inventory for one bounded run | [Standalone fleet workflow](configuration.md#standalone-agentic-workflows). |
| Independent target execution, retries, or specialized workers | Campaign; browse the [catalog](https://githubnext.github.io/gh-cao/catalog/). |
| Deterministic work, approvals, or long waits | Ordinary GitHub Actions. |

Try the [Repo Status quickstart](setup/quickstart.md) for one standalone report,
without repeating setup.

None is enrolled, enabled or run by setup. If a campaign fits and installation
is approved, install it separately:

```bash
gh cao campaigns add githubnext/gh-cao/CAMPAIGN
```

Installation is not execution. For any pattern, review and commit workflows and
policy together before enabling or running them. Start in **review** mode with **one
repository**; model access and AI credits are separate prerequisites.
See [Roll out a campaign](rollout-and-routing.md) for the execution steps.

The [Repo Assist walkthrough](repo-assist-quickstart.md) shows an optional
review-only campaign request after setup.

## Continue learning

- [Explore the dashboard](dashboard.md).
- [Configuration](configuration.md): understand your policy.
