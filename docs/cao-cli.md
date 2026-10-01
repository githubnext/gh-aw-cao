---
title: CAO Commands
description: Configure, control, inspect, and evolve a CAO control plane from its repository-local CLI.
agent:
  type: cli-reference
  prominent: true
---

Use this reference when operating CAO or adding a CLI command. The installer
adds an executable `./cao.sh` wrapper to the control repository; command
implementation lives under `activity/cao.mjs` and its focused modules. Agents
using the CLI should follow the
[`cao-cli` skill](https://github.com/githubnext/gh-aw-cao/blob/main/skills/cao-cli/SKILL.md);
agents querying activity data should use
[`analyze-cao`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/analyze-cao/SKILL.md).
Run the wrapper from the repository root:

```bash
./cao.sh --help
```

CAO and gh-aw have separate jobs:

- **`./cao.sh`** configures CAO policy, authentication, installed campaigns, workflow enablement, and operational data.
- **`gh aw run`** starts a compiled agentic workflow.
- **`gh run`** lists, watches, and inspects the resulting GitHub Actions runs.

## Common Operator Loop

```bash
# Add a campaign and merge its workers into CAO policy.
./cao.sh add githubnext/gh-aw-cao/dependabot

# Keep the campaign review-only and enable its workflows.
./cao.sh mode preview dependabot
./cao.sh enable dependabot

# Review and commit the workflow and policy changes together.
git diff -- .github
git add .github
git commit -m "Configure Dependabot campaign"
git push

# Run one bounded review.
gh aw run dependabot --ref main \
  --raw-field target_repo="acme/example-service" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

`cao mode preview` writes `mode: review` to `.github/workflows/cao.json`. The word *preview* distinguishes this operator command from a live promotion; campaign execution still reports `review` mode.

## Configure the Control Plane

| Command | Use it to |
| --- | --- |
| `./cao.sh setup` | Interactively choose repository scope, inspect visibility and ownership, and configure a compatible authentication profile. |
| `./cao.sh init` | Create a minimal review-safe policy when one does not exist. It refuses to overwrite an existing policy. |
| `./cao.sh setup-auth github-app ...` | Configure organization-owned read and write Apps. |
| `./cao.sh setup-auth enterprise-app ...` | Configure existing enterprise-owned Apps with policy-derived read scope and explicit `--write-repository` output scope. |
| `./cao.sh setup-auth token ...` | Configure explicitly consented owner-scoped fine-grained PAT pairs when an App is unavailable. |
| `./cao.sh add OWNER/REPO/CAMPAIGN` | Install one campaign and merge its declared workers into policy without broadening rollout or enabling live mode. |
| `./cao.sh update` | Upgrade gh-aw when required, update installed campaigns, and refresh worker declarations while preserving operator-owned settings. |
| `./cao.sh upgrade-gh-aw VERSION` | Install an exact gh-aw release, upgrade local Agentic Workflow files, and update the pinned policy version after the upgrade succeeds. |

Use `./cao.sh setup` for initial configuration. The individual `setup-auth` commands remain available for manual and non-interactive administration.

## Control Campaigns

```bash
# Map the campaign to review mode in policy.
./cao.sh mode preview dependabot

# Promote only after review and explicit approval.
./cao.sh mode live dependabot

# Enable or disable every installed workflow declared by the campaign.
./cao.sh enable dependabot
./cao.sh disable dependabot
```

These commands accept multiple campaign slugs:

```bash
./cao.sh disable dependabot repo-assist
```

`mode live` does not widen repository scope, grant target consent, or create credential access. Complete the [live rollout gates](rollout-and-routing.md) separately.

`disable` prevents new starts for the campaign's installed workflows. It does not cancel an active run or replace the [control-plane emergency stop](operations.md#emergency-stop).

## Validate the Control Plane

Run the same read-only validator locally and in CI:

```bash
./cao.sh validate
./cao.sh validate --json
```

Validation checks the policy with the production resolver, the installed gh-aw compiler version, strict compilation and generated workflow drift, campaign workflow identity and enablement, `gh aw doctor`, and bounded trust-boundary security rules. GitHub workflow state is reported as unknown when API access is unavailable. Warnings do not fail by default; use `--strict-warnings` to make them fail.

Strict compilation runs against a committed temporary snapshot of the current
workflow files. Normal uncommitted local edits are still validated, but they do
not produce an unrelated dirty-working-tree warning from `gh aw`.

Exit code `0` means no validation errors, `1` means validation findings failed the requested threshold, and `2` means the validator itself could not complete. Validation never rewrites workflow artifacts; run `npm run compile:locks` to regenerate stale locks.

## Run and Watch a Campaign

There is intentionally no `cao run` command. gh-aw owns workflow execution:

```bash
gh aw run CAMPAIGN --ref BRANCH \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

CAO Activity and CAO Dashboard are conventional GitHub Actions workflows, not
Agentic Workflows, so operate them with GitHub CLI instead of `gh aw`:

```bash
gh workflow run cao-activity.yml
gh run list --workflow cao-activity.yml
gh run list --workflow cao-dashboard.yml
```

Then use GitHub CLI to find and watch the orchestrator:

```bash
gh run list --workflow CAMPAIGN.lock.yml --event workflow_dispatch --limit 5
gh run watch RUN_ID --exit-status
```

Manual inputs may narrow checked-in policy for one run; they never widen it.

## Inspect Activity

First download the JSONL shards and SQLite snapshot published by your deployed CAO dashboard:

```bash
./cao.sh download --url https://OWNER.github.io/CONTROL_REPO/cao/payload-hashes.json
```

The download remains local under `.cao/`. It is derived evidence, not rollout authority.

Use the gh-like query surface for common questions:

```bash
./cao.sh gh runs --repo OWNER/REPOSITORY --status failure --limit 20
./cao.sh gh issues --repo OWNER/REPOSITORY --since 2026-09-01
./cao.sh gh prs --repo OWNER/REPOSITORY --workflow WORKFLOW --limit 10
```

Check runtime health or query canonical records:

```bash
./cao.sh computation intelligence
./cao.sh computation intelligence --campaign dependabot --previous prior-intelligence.json --feedback decision-feedback.json
./cao.sh computation runtime-health --campaign dependabot
./cao.sh computation runtime-health --campaign dependabot --diagnose

./cao.sh query \
  --collection runs \
  --where conclusion=failure \
  --limit 20
```

For the computation model and result semantics, see
[Intelligence](intelligence.md),
[Runtime Health Computation](computation-runtime-health.md), and
[Portfolio Intelligence Computation](computation-intelligence.md).

The `intelligence` computation fingerprints canonical runtime-health evidence,
correlates matching failure signals, suppresses ineligible or recovering
candidates, and emits advisory Decisions. It never dispatches workers or grants
execution authority. Passing a prior result with `--previous` reuses unchanged
nonterminal Decisions. A versioned `--feedback` file binds dispositions to a
Decision ID and input fingerprint; unchanged terminal Decisions are suppressed,
while stale feedback remains inspectable and cannot affect changed evidence.

The result also includes partial Campaign intelligence contracts compiled from
declared canonical inventory. Undeclared problem, outcome, schedule, overlap,
attention, and operational-value fields remain `null`; descriptions and READMEs
are not reinterpreted as those contracts.

Feedback uses this shape:

```json
{
  "contractVersion": "1.0.0",
  "records": [{
    "decisionId": "runtime-health-decision:...",
    "inputFingerprint": "sha256:...",
    "disposition": "deferred",
    "observedAt": "2026-10-01T11:00:00Z",
    "actor": "operator:octocat",
    "authority": "control-repository-review"
  }]
}
```

Allowed dispositions are `accepted`, `rejected`, `deferred`, `superseded`,
`recovered`, `expired`, and `unresolved`. Feedback never grants execution
authority.

Render a named dashboard query as an editable agent prompt with the same template as the UI:

```bash
./cao.sh prompt cost-by-campaign
./cao.sh prompt campaign-runs --param campaign=dependabot --database .cao/gh-aw-logs.sqlite
```

Without `--database`, the command needs no downloaded snapshot and includes no evidence rows. With `--database FILE`, it executes the named query against that existing snapshot and includes a bounded preview; this does not grant rollout authority. Use `--dashboard FILE` to experiment with a different dashboard definition.

Run `./cao.sh doctor` to validate and repair the downloaded SQLite snapshot. This is different from `gh aw doctor`, which validates the workflow installation and repository setup.

## Evaluate and Evolve

The CLI also exposes evidence used to improve campaigns:

| Command | Purpose |
| --- | --- |
| `./cao.sh operational-value` | Compute campaign-specific value evidence from the canonical snapshot. |
| `./cao.sh cluster-problems` | Cluster bounded problem evidence emitted by installed campaigns. |
| `./cao.sh dashboard-complexity --input FILE [--database FILE]` | Rank Dashboard Language queries by estimated computation pressure. |
| `./cao.sh prune-dashboard --input FILE` | Report reusable, redundant, and unreferenced dashboard queries and views. |

Without `--database`, `dashboard-complexity` normalizes every canonical database table to weight one. With `--database FILE`, it weights tables by their deployed row counts (normalized to the largest table) read from that downloaded snapshot, giving a more realistic computation-pressure ranking.

Data-pipeline and dashboard-maintainer commands are listed by `./cao.sh --help`. For the full data workflow, see [Dashboard data ingestion](dashboard-data-ingestion.md#use-local-sqlite).

## Review What Each Command Changed

`init`, `add`, `update`, `upgrade-gh-aw`, and `mode` can change checked-in control-plane files. Review those changes and commit workflow sources, generated locks, and `.github/workflows/cao.json` together:

```bash
git status --short
git diff -- .github
```

Never edit generated `.github/workflows/*.lock.yml` files by hand. Never treat a successful command as permission to widen scope or enable live output.
