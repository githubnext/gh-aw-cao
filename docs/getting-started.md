---
title: Quickstart
description: Install CAO, configure authentication, add a campaign, and prove one bounded review run.
---

In about 15 minutes, you will install CAO in a new control repository and run one campaign against one exact repository in `review` mode.

This quickstart uses the real setup commands directly:

```text
install.sh → ./cao.sh setup-auth → ./cao.sh add → gh aw run
```

The example chooses one safe path:

- a new, separate, private control repository;
- the ready-made Dependabot campaign;
- one public target in the same organization;
- GitHub's built-in token;
- one write-free review run.

**Nothing in the external target repository will change.**

## Before You Start

You need:

- permission to create a repository in a GitHub organization;
- one low-risk public repository in that organization;
- [GitHub CLI](https://cli.github.com/) installed and authenticated;
- GitHub Actions enabled;
- organization-billed GitHub Copilot for the bundled Dependabot workflows.

CAO installation does not require Copilot billing. Only the Copilot-backed run does.

Check GitHub CLI:

```bash
gh auth status
```

If repository and workflow access is missing:

```bash
gh auth login --scopes repo,workflow
```

## 1. Create and Install

Replace the example organization and target, then run the commands:

```bash
CONTROL_REPO="acme/central-agentic-ops"
TARGET_REPO="acme/example-service"

gh repo create "$CONTROL_REPO" --private --clone
cd "${CONTROL_REPO##*/}"

curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
```

The idempotent installer uses a compatible `gh-aw` version, adds the latest published core CAO campaign, initializes the minimal control policy, installs the shared control-plane runtime, and makes the repository-local `./cao.sh` CLI executable. If `gh-aw` is too old, the installer asks before upgrading it and prints the upgrade command when declined or run without an interactive terminal. It passes `--no-security-scanner` because gh-aw's Markdown scanner rejects the GitHub App manifest page in `.github/workflows/shared/setup-github-apps.mjs`; review the installed diff before committing. Use individual `gh aw` and CAO CLI commands when intentionally installing an older campaign release.

- verifies or installs `gh-aw`;
- installs the latest published core CAO campaign;
- creates a minimal review-safe `.github/workflows/cao.json`;
- installs the shared control-plane runtime;
- makes the repository-local `./cao.sh` CLI executable.

Rerunning it after those files are installed makes no changes.

Do not run `gh aw init`, copy runtime files manually, or edit generated `.github/workflows/*.lock.yml` files.

## 2. Configure Authentication

The target is public and review output stays in the control repository, so select the built-in token profile:

```bash
./cao.sh setup-auth workflow-token
```

This profile adds no secret. It can perform control-repository work and bounded public-target review. If cross-repository evidence is unavailable, the worker reports an incomplete result instead of guessing.

Use [Authentication](authentication.md) instead when the target is private or internal, belongs to another organization, requires an alternate review destination, or will receive a live write.

## 3. Add a Campaign

Install Dependabot and merge its orchestrator and workers into CAO policy:

```bash
./cao.sh add githubnext/gh-aw-cao/dependabot
```

Run CAO commands from the control repository with `./cao.sh`. Its `init` command creates the minimal `.github/workflows/cao.json` and refuses to overwrite an existing policy. The new policy's `control-plane.scope` allows only the repository that `gh repo view` reports for the current checkout, so the first Activity run can collect the control repository with the built-in workflow token; `init` fails without writing a policy when that repository cannot be determined. Broaden scope only as an explicit policy and credential decision. `setup-auth` configures private organization or enterprise Apps, an explicitly acknowledged fine-grained token, or the built-in workflow-token profile. `add` invokes `gh aw add`, reads the installed campaign's CAO declaration, and adds its worker identities without enabling live mode or broadening repository scope. `update` upgrades `gh-aw` to the policy's minimum version, updates installed campaigns, and refreshes declared worker identities while preserving operator-owned rollout settings. Use `mode live CAMPAIGN...` to promote configured campaigns or `mode preview CAMPAIGN...` to return them to review mode; the command validates every campaign name before updating `.github/workflows/cao.json`. Use `enable CAMPAIGN...` or `disable CAMPAIGN...` to run the corresponding GitHub workflow action for each campaign's orchestrator and every declared worker workflow.

Dependabot is this quickstart's example, not a hidden default. You can choose another outcome from [Browse Campaigns](catalog.md) and substitute its campaign and orchestrator names below.

## 4. Enroll One Target

Open `.github/workflows/cao.json`. Add both the target owner and exact target repository under `control-plane.scope`. Keep the campaign settings generated by `./cao.sh add`:

```json title=".github/workflows/cao.json"
{
  "version": 1,
  "gh-aw-version": "v0.89.21",
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"],
      "allowed-repositories": ["acme/example-service"]
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

Replace both occurrences of `acme` and the repository name. Omitted campaign settings remain `review`, one repository, and 100 percent rollout.

Replace both occurrences of `acme` and the repository name. The installer initially scopes policy to the control repository, so replace that bootstrap entry with the target owner and exact `TARGET_REPO`. Keep the control repository only if it is also a target you want reviewed. Omitted campaign settings default to `review`, one repository, and 100 percent rollout.

To review the control repository itself, set `TARGET_REPO="$CONTROL_REPO"` and enroll that exact repository instead.

## 5. Commit and Check

Commit the policy, workflow sources, generated locks, and runtime together so `github.workflow_sha` identifies one atomic configuration:

```bash
git add .github activity dashboard cao.sh
git commit -m "Install reviewed Dependabot campaign"
git push --set-upstream origin HEAD

gh aw doctor --repo "$CONTROL_REPO" --dir .
```

One commit now identifies the workflow and policy revision used by the run.

## 6. Run One Review

```bash
gh aw run dependabot --ref main \
  --raw-field target_repo="$TARGET_REPO" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

Replace `main` with the control repository's default branch when necessary.

Find and watch the run:

```bash
gh run list --workflow dependabot.lock.yml --event workflow_dispatch --limit 5
gh run watch <run-id> --exit-status
```

The orchestrator may start a separate worker. Open the orchestrator in the control repository's **Actions** tab to follow the correlated run.

## 7. Verify the Boundary

The proof succeeds when:

- exactly the selected repository was admitted;
- no more than one expected worker ran;
- the effective mode was `review`;
- every write was a declared review output in the control repository;
- an external target received no issue, pull request, branch, or file change.

For self-review, review output may appear in the control repository, but the run must still report `review` mode and produce no live target effect. A `noop` or incomplete result is valid when the boundary holds and the missing evidence is explained.

## Need a Different Setup?

Complete the direct quickstart first when possible. Use these adjustments when the example does not match your environment:

| Your situation | Adjustment |
| --- | --- |
| Existing separate control repository | Preserve its visibility and contents; run the installer from its checkout. |
| Public control repository | Continue only when policy, run metadata, dashboard data, and review outputs may all be public. |
| Source-managed control repository | Do not run the installer over in-tree workflows. Verify its committed policy, shared runtime, workflow sources, and locks together. |
| Private or internal target | Use a private control repository and [configure target authentication](authentication.md) before the run. |
| Target in another organization | Use the appropriate enterprise App or eligible PAT path before the run. |
| Custom campaign | Prove the base control plane with one catalog campaign, then [build the custom campaign](author-your-first-operation.md) as a separate change. |

### Prefer Guided Setup?

Ask a coding agent to follow the [`setup-cao` skill](https://github.com/githubnext/gh-aw-cao/blob/main/skills/setup-cao/SKILL.md) when you need help choosing among those routes:

```text
Read and follow skills/setup-cao/SKILL.md.

Set up a Central Agentic Ops control plane and prove one review-mode run.
Ask me to choose the control repository, catalog campaign, custom-campaign
interest, and first target. Do not enable live mode.
```

The skill asks for each required decision before changing the repository. It does not silently choose a campaign, broaden scope, or enable live output.

## After the First Proof

Treat each next step as a separate reviewed change:

- [learn the CAO commands](cao-cli.md) for campaign control and operational queries;
- [add another catalog campaign](catalog.md);
- [build a custom campaign](author-your-first-operation.md);
- [enroll private targets](authentication.md);
- [expand or promote rollout](rollout-and-routing.md);
- [monitor runs and recover safely](operations.md).
- Learn how to promote the campaign from [review to live](rollout-and-routing.md).
- Read [How the Control Plane Works](architecture.md) before adding organizations or broader repository discovery.
- Use the [Configuration Reference](configuration.md) to tune schedules, repository limits, and worker ceilings.
- Review [Orchestrators and Workers](orchestrators-and-workers.md) before creating another campaign.
- Choose where to host the dashboard in [Deployment options](deployment.md).
