---
title: Quickstart
description: Create a private control plane, install one operation, and run it safely against one repository.
---

Central Agentic Ops lets you run governed agentic operations across many repositories from one private GitHub repository, which we call the central control plane. Operation campaigns, credentials, rollout policy, and workflow runs stay in the control plane; target repositories do not receive copies of the workflows.

By the end of this guide, you will have created a control plane, installed the Dependabot operation, and completed one `review` run against a public target repository. You will verify that the operation selected the expected target, saved any proposal in the private control repository, and did not change the target.

## Run a Reviewed Dependabot Operation

Estimated time: 15 minutes

This quickstart uses one public repository owned by the same organization as the control repository. That path requires no GitHub App or personal access token.

## Prerequisites

Before you begin, make sure you have:

- a GitHub organization where you can create a private repository;
- one low-risk public repository in that organization to use as the target;
- GitHub Actions enabled for both repositories;
- [GitHub CLI](https://cli.github.com/) installed and authenticated;
- access to GitHub Copilot through organization billing for Agentic Workflow runs.

:::tip[Start with the setup skill]
From an empty control repository, ask your coding agent to load and follow the
[`setup-cao` skill](https://github.com/githubnext/gh-aw-cao/blob/main/.github/skills/setup-cao/SKILL.md).
The skill gathers the control repository, operation, target, visibility, and authentication choices before it changes the repository, then proves the boundary with one review run. The manual steps below describe the same boundary for operators who need to inspect each action.
:::

Check your GitHub CLI authentication:

```bash
gh auth status
```

If needed, sign in with repository and workflow access:

```bash
gh auth login --scopes repo,workflow
```

:::note[Using a private or cross-organization target?]
Complete [Configure Authentication](authentication.md) before running the operation. The credential must cover the target repository, and its owner must be allowlisted.
:::

### Step 1 - Create the control repository

Choose names for the private control repository and public target repository. Replace the examples below with repositories you own:

```bash
CONTROL_REPO="acme/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"
```

The new private repository is the central control plane. Agentic Workflow definitions and credentials stay here; they are not installed in the target repository.

:::caution[Keep the control plane private]
The control repository holds credentials, rollout policy, and cross-repository operating records. Do not make it public.
:::

### Step 2 - Verify GitHub CLI

Confirm that GitHub CLI is available:

```bash
gh --version
```

### Step 3 - Add Central Agentic Ops

From the control repository, run the idempotent installer:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
```

The script installs `gh-aw` when needed, adds the latest published core CAO campaign, and initializes the minimal control policy. Rerunning it after those files are installed makes no changes. Use the individual `gh aw` and `cao` commands when you intentionally need an older campaign release.

The root campaign installs:

1. shared authentication, routing, and fail-closed controls;
2. the activity and dashboard infrastructure;
3. the `cao` CLI runtime under `.github/aw/activity/`; and
4. CAO project skills under `.github/skills/` for Copilot discovery in the control repository.

Use the `add-cao-campaign` skill to discover and compare catalog operations when you do not already know which campaign fits. After explicit selection, it installs through CAO so the campaign declaration is merged automatically. For example, install Dependabot with:

```bash
node .github/aw/activity/cao.mjs add githubnext/gh-aw-cao/dependabot
```

`cao init` creates the minimal `.github/workflows/cao.json` and refuses to overwrite an existing policy. `cao add` invokes `gh aw add`, reads the installed campaign's CAO declaration, and adds its worker identities without enabling live mode or broadening repository scope. `cao update` upgrades `gh-aw` to the policy's minimum version, updates installed campaigns, and refreshes declared worker identities while preserving operator-owned rollout settings. Use `cao mode live CAMPAIGN...` to promote configured campaigns or `cao mode preview CAMPAIGN...` to return them to review mode; the command validates every campaign name before updating `.github/workflows/cao.json`. Use `cao enable CAMPAIGN...` or `cao disable CAMPAIGN...` to run the corresponding GitHub workflow action for each campaign's orchestrator and every declared worker workflow.

> [!WARNING]
> Do not edit generated `.lock.yml` files directly. Update their Markdown sources and regenerate them with `gh aw compile`.

### Step 4 - Set the first-run boundary

Add the target owner to the generated `.github/workflows/cao.json`. The campaign and worker declaration is already present; omitted campaign settings default to `review`, one repository, and 100 percent rollout:

```json title=".github/workflows/cao.json"
{
	"version": 1,
	"gh-aw-version": "v0.89.15",
	"control-plane": {
		"scope": {
			"allowed-owners": ["acme"]
		},
		"campaigns": {
			"dependabot": {
				"workers": {
					"update-planner": {
						"workflow": "dependabot-update-planner"
					}
				}
			}
		}
	}
}
```

Replace `acme` if your target has a different owner. Commit the workflow sources, generated locks, CAO runtime resources, and policy together so `github.workflow_sha` identifies one atomic configuration:

```bash
git add .github
git commit -m "Install reviewed Dependabot operation"
git push --set-upstream origin HEAD
```

### Step 5 - Trigger one review run

Run the installed orchestrator against the target repository:

```bash
gh aw run dependabot --ref main \
	--raw-field target_repo="$TARGET_REPO" \
	--raw-field max_repos="1" \
	--raw-field rollout_percent="100" \
	--raw-field safe_output_mode="review"
```

You can also open the control repository's **Actions** tab, select **Dependabot**, and choose **Run workflow** with the same values.

The orchestrator should select only the named repository and dispatch at most one updater. In `review` mode, proposed safe outputs are saved in the private control repository without creating or changing issues, pull requests, branches, or files in the target.

### Step 6 - Wait for the operation to complete

List the latest Dependabot runs:

```bash
gh run list --workflow dependabot.lock.yml --event workflow_dispatch --limit 5
```

Copy the run ID from the first row, then watch it until completion:

```bash
gh run watch <run-id> --exit-status
```

The orchestrator may dispatch a separate updater run. Open the orchestrator run in the **Actions** tab to follow its correlated worker and inspect the review output.

## Verify the Result

A successful first run proves the boundary:

- the orchestrator selected exactly `TARGET_REPO`;
- no more than one updater was dispatched;
- the worker remained in `review` mode;
- the review output in the control repository links back to the control-plane run;
- no issue, pull request, branch, or file was written to the target repository.

The worker may report that no dependency work is needed. That is still a successful first run when target selection, routing, and zero-write behavior are correct.

Having trouble? Check [Configure Authentication](authentication.md) for repository access, [Configuration](configuration.md) for policy fields, or [Monitor and Recover](operations.md) for failed runs.

## What's Next?

- Learn how to promote the operation from [review to live](rollout-and-routing.md).
- Read [How the Control Plane Works](architecture.md) before adding organizations or broader repository discovery.
- Use the [Configuration Reference](configuration.md) to tune schedules, repository limits, and worker ceilings.
- Review [Orchestrators and Workers](orchestrators-and-workers.md) before creating another operation.