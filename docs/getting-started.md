---
title: Quickstart
description: Create a private control plane, install one operation, and run it safely against one repository.
---

Central Agentic Ops lets you run governed agentic operations across many repositories from one private GitHub repository, which we call the central control plane. Operation packages, credentials, rollout policy, and workflow runs stay in the control plane; target repositories do not receive copies of the workflows.

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
[`setup-central-agentic-ops` skill](https://github.com/githubnext/gh-aw-cao/blob/main/.github/skills/setup-central-agentic-ops/SKILL.md).
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

### Step 2 - Install the `gh-aw` extension

Install GitHub Agentic Workflows:

```bash
gh extension install github/gh-aw
```

If the extension is already installed, verify that it is available:

```bash
gh aw --help
```

### Step 3 - Add Central Agentic Ops

From the control repository, install the CAO package from a pinned catalog release. Replace `<catalog-release>` with a release tag or full commit SHA:

```bash
CAO_REF="<catalog-release>"
gh aw add "githubnext/gh-aw-cao@${CAO_REF}"
```

The package installs:

1. the catalog's operational orchestrators and workers, including **Dependabot**;
2. shared authentication, routing, and fail-closed controls;
3. the CAO policy schema, runtime, and setup resources under `.github/aw/cao`;
4. generated `.lock.yml` workflows that GitHub Actions executes.

The runtime is installed from the same package revision as the workflows. Commit the installed files with the consumer-owned policy so every run resolves one atomic revision. See [Admission Gates](admission.md) for the checks this runtime performs before activation.

The installed operation is runnable after its package and worker workflow identities are declared in the control policy. Declared workers are enabled unless their policy sets `enabled: false`; undeclared or disabled identities are skipped by admission before agent execution.

> [!WARNING]
> Do not edit generated `.lock.yml` files directly. Update their Markdown sources and regenerate them with `gh aw compile`.

### Step 4 - Set the first-run boundary

Create `.github/workflows/cao.json` with the target owner and package. The omitted package settings default to `review`, one repository, and 100 percent rollout:

```json title=".github/workflows/cao.json"
{
	"version": 1,
	"gh-aw-version": "v0.89.8",
	"control-plane": {
		"scope": {
			"allowed-owners": ["acme"]
		},
		"packages": {
			"dependabot": {
				"workers": {
					"release-train-updater": {
						"workflow": "dependabot-release-train-updater"
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