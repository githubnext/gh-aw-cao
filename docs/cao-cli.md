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
The Go extension exposes the operator-facing command surface as `gh cao`.
The repository-local wrapper remains compatible, including the pipeline
commands used by Actions. Run either interface from the control repository root:

```bash
gh cao --help
./cao.sh --help
```

Command failures exit nonzero and report the error without printing the command
reference. Request command-specific help with `gh cao COMMAND --help`.

## GitHub CLI extension

Build with `make build` and use `./gh-cao` directly, or follow the
[local extension installation guide](https://github.com/githubnext/gh-aw-cao/blob/main/CONTRIBUTING.md#go-extension-development)
to invoke it as `gh cao`.

| Surface | Commands | Execution |
| --- | --- | --- |
| Policy and workflow controls | `init`, `campaigns mode`, `campaigns enable`, `campaigns disable` | Native Go; no Node runtime required. |
| Campaign installation | `campaigns add CAMPAIGN [GH_AW_ADD_OPTIONS...]` | Native Go; gh-aw owns installation records and workflow generation, Go materializes campaign resources and merges policy. No Node runtime required. |
| Onboarding and lifecycle | `setup`, `quickstart`, `setup-auth github-app\|enterprise-app\|token`, `repos add OWNER/REPO`, `update`, `upgrade-gh-aw`, `validate` | Go command/argument layer with the installed production CAO Node runtime. |
| Read-only analysis | `download`, `pages`, `queries`, `query-info`, `prompt`, `query`, `gh runs\|issues\|prs`, `computation intelligence\|runtime-health`, `mcp` | Same installed runtime and canonical query engine as the dashboard and existing CLI. |
| Installation diagnostics | `doctor`, `version` | Native Go. `doctor` checks GitHub CLI, gh-aw, authentication, and basic local policy structure and compiler pin. |
| Actions pipeline and maintainer tools | `discover-workflows`, `ingest`, `ingest-jsonl`, `audit-jsonl`, `compact-jsonl`, `recycle-cache`, `issue-status`, `hash-payloads`, `activity-stats`, `validate-activity-data`, `operational-value`, `cluster-problems`, `dashboard-complexity`, `prune-dashboard` | Remain in `./cao.sh` / `activity/cao.mjs`; not migrated to the extension. |

The extension is **not yet a Node-free replacement** for the domain runtime.
Shared-runtime commands require Node.js 24+ and the installed CAO root campaign.
The extension finds `activity/cao.mjs` in the current checkout (without crossing
its Git boundary), or beside the extension executable. Set `CAO_RUNTIME_ROOT`
to select another installed runtime explicitly; an invalid override fails
without fallback. Selecting runtime code does not change the current directory
or policy authority, and never downloads code implicitly.

```bash
gh cao init
gh cao campaigns add githubnext/gh-aw-cao/dependabot
gh cao repos add acme/example-service
gh cao campaigns mode preview dependabot
gh cao campaigns enable dependabot
gh cao campaigns disable dependabot
gh cao validate --json
gh cao pages --json
gh cao query campaign-runs --param campaign=dependabot
```

All help works offline, including `gh cao quickstart --help` and
`gh cao campaigns --help`. Campaign controls are available only under
`campaigns` in the extension; `./cao.sh mode`, `./cao.sh enable`, and
`./cao.sh disable` keep their existing syntax.
Repository enrollment uses `gh cao repos add OWNER/REPO`; the extension has no
root-level `add` command. `./cao.sh add CAMPAIGN` and
`./cao.sh add --repository OWNER/REPO` retain their existing syntax.
`gh cao setup-auth token --help` also works offline. `campaigns add` and `update` retain
gh-aw option passthrough. JSON output, repeatable query parameters, stdin queries, interactive
secret prompts, and validator exit codes retain their existing contracts.
There is no `gh cao run`: workflow execution still belongs to gh-aw.

Campaign installation fetches only the installed package's full `resolvedCommit`
SHA from the official catalog, or copies only Git-tracked campaign files from a
local catalog checkout. It replaces the selected campaign's resources, refreshes
its intelligence metadata, and merges declared workers while preserving existing
enablement, mode ceilings, campaign settings, and repository scope. It does not
reinstall the control-plane runtime or plugin. Missing policy is initialized for
the exact current control repository. Install the root package with `install.sh`,
not `gh cao campaigns add`; review and commit generated workflows and policy together.

`gh cao doctor` is deliberately **not** `./cao.sh doctor`: use the latter for
the existing SQLite snapshot check/repair operation. Neither Activity nor
Dashboard Actions is switched to the Go executable.

### Diagnose the installation

Run `gh cao doctor` from the control repository root, or use
`gh cao doctor --json` for machine-readable results. No Node.js runtime is
required. Checks cover:

- The GitHub CLI executable and installed gh-aw version.
- Authentication reported by `gh auth status`, which may contact GitHub.
- The local `.github/workflows/cao.json` file's basic structure and exact
  `gh-aw-version` pin, including agreement with the installed compiler.

Text output labels each check `PASS`, `FAIL`, or `SKIP` and provides remediation
for failures. JSON output contains `command`, `ok`, and `checks`; each check has
`name`, `status`, `message`, and optional `remediation`. Results are still emitted
when checks fail; the command exits nonzero on any failed or skipped check.
External checks have a 15-second timeout (the local GitHub CLI version probe
has a shorter five-second limit). Cancellation stops the diagnostic.

The command is read-only: it does not install extensions, log in, modify policy,
repair databases, or change remote settings. Raw authentication output and
subprocess errors are not included in reports. A passing basic policy check
does not establish rollout authority or full schema validity; use
`gh cao validate` for production policy and workflow validation.

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
| `./cao.sh quickstart --target OWNER/REPO` | Explicitly select the public target, install and commit the review-only control plane, and leave Repo Assist paused without dispatching or waiting. Equivalent to `--step install`. |
| `./cao.sh quickstart --step run` | Dispatch one bounded Repo Assist review using existing policy, then pause the orchestrator and return an Actions link. |
| `./cao.sh quickstart --step collect` | Dispatch Activity collection and return without waiting. Use after the maintenance outcome is available. |
| `./cao.sh quickstart --step dashboard` | Check Activity evidence and dashboard deployment read-only; repeat if pending. |
| `./cao.sh quickstart --wait --target OWNER/REPO` | Explicitly select the target and opt into the original install-through-dashboard flow with remote waits; not a resume or status command. |
| `./cao.sh setup` | Interactively choose repository scope, inspect visibility and ownership, and configure a compatible authentication profile. |
| `./cao.sh init` | Create a minimal review-safe policy when one does not exist. It refuses to overwrite an existing policy. |
| `./cao.sh setup-auth github-app ...` | Configure organization-owned read and write Apps. |
| `./cao.sh setup-auth enterprise-app ...` | Configure existing enterprise-owned Apps with policy-derived read scope and explicit `--write-repository` output scope. |
| `./cao.sh setup-auth token ...` | Configure explicitly consented owner-scoped fine-grained PAT pairs when an App is unavailable. |
| `./cao.sh add OWNER/REPO/CAMPAIGN` | Install one campaign and merge its declared workers into policy without broadening rollout or enabling live mode. |
| `./cao.sh add --repository OWNER/REPO` | Verify GitHub CLI read access and stage one exact repository in local control-plane policy, with review-mode overrides for existing campaigns. |
| `./cao.sh update` | Upgrade gh-aw when required, update installed campaigns, and refresh worker declarations while preserving operator-owned settings. |
| `./cao.sh update --campaign SLUG` | Update exactly one installed campaign, retaining runtime materialization and worker-declaration refresh. Use `root` for the CAO root package. |
| `./cao.sh upgrade-gh-aw VERSION` | Install an exact gh-aw release, upgrade local Agentic Workflow files, and update the pinned policy version after the upgrade succeeds. |

Omit `--campaign` to update all installed CAO packages. Selection also works with
refs and update options, for example `./cao.sh update main --campaign dependabot`.
The slug is the last component of the installed package name (`root` for
`githubnext/gh-aw-cao`). Unknown, ambiguous, empty, unsafe, or repeated selections
fail before updates or gh-aw upgrades. Campaign selection does not narrow a
required gh-aw compiler upgrade, which may refresh shared workflow files.

The canvas Updates page exposes **Add repository** beside Repositories. Its
debounced GitHub search only selects a target; execution still requires fresh
approval of the exact `./cao.sh add --repository OWNER/REPO` command. Enrollment
requires existing exact owner and repository allowlists and does not rewrite a
broad discovery policy. An already enrolled repository is unchanged. New targets
stay in review mode even when a campaign defaults to live. The command neither
commits nor pushes, enables campaigns, changes rollout limits, configures
credentials, nor expands an explicitly narrowed Activity scope. Review and commit
the policy before activation at a reviewed workflow SHA.

Use `./cao.sh quickstart --target OWNER/REPO` only immediately after verified installation in a
clean public or private control repository on its default branch. Existing
commits are allowed; the install stage adds one bounded CAO commit and pauses
Repo Assist without dispatching it. Continue with `--step run`, inspect its
outcome in Actions, then use `--step collect` and `--step dashboard`.
The command prints persistent, numbered explanations of the selected repositories
and package, installed components, policy, authentication, public Pages visibility,
and commit/push effects before applying each phase. Each stage ends with a
**Before continuing** inspection checkpoint, not just the next command.
`--json` suppresses progress; installation returns the same `guide` details and
`checkpoint` as structured data without adding interactive prompts.
Only the read-only dashboard step is a repeatable status check; repeating run
or collect requests new work. The run stage can consume
up to 1,250 AI credits under default limits (250 orchestration + 600 maintenance
+ 400 output checking; configured output-check limits may differ),
with each stage owning only its documented effects in the
[quickstart](setup-quickstarts.md). Use `./cao.sh setup` for
review-before-apply configuration. The individual `setup-auth` commands remain
available for manual and non-interactive administration.

Without an interactive terminal or when `CI` is set, `./cao.sh setup` applies
only the agent-safe public profile: exact current-repository read and Activity
scope, no campaigns, public Actions-backed Pages, and repository
`GITHUB_TOKEN` (`workflow-token`) authentication. It refuses private/internal
control repositories, broader existing policy, or installed campaigns.
`./cao.sh setup --json` returns the applied profile with
`"nonInteractive": true`. Bare installation remains usable before setup with
exact control-repository scope, no operational campaigns, and
repository-local workflow-token Activity access.
Explicit quickstart is also terminal-independent. Installation and `--wait`
require `--target OWNER/REPO`; no owner or repository is suggested or selected
for you. Later stages reuse the target in committed policy.
The public target receives one validated maintenance proposal or no-op,
not a readiness or eligibility grade. Applying the proposal
is never required for using CAO. Existing Agentic Workflows, Actions
history, or telemetry are not required.
Only the existing maintenance worker is enabled. The normal orchestrator is
paused after installation; the run step enables it only for its dispatch and
pauses it again through `gh workflow disable`. Re-enable
it explicitly for further runs; doing so also resumes its six-hour schedule.
`--target OWNER/REPO` selects another existing public repository. The checkout,
target-visibility and default-branch preflight remain
fail-closed.

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
It also checks whether the control repository has a selected GitHub App or PAT with write credentials configured. If CI can confirm they are missing, it suggests `./cao.sh setup`; lack of permission to inspect Actions settings does not block the mode change. This check does not verify installation access or token permissions.

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

CI writes its JSON report under `RUNNER_TEMP`, outside the checkout, before
uploading the `cao-validation` artifact. This keeps report creation from
triggering a false `gh aw doctor` warning and validation issue on a fresh
installation. When redirecting local JSON output, likewise use a path outside
the checkout so the report does not make the repository appear modified.

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

For a single-worker development loop without a dispatcher, use
[Local Worker Debugging](local-debugging.md). Its request-only `debug` mode
is not a `cao mode` command or a campaign configuration.

CLI failures print one actionable message by default. Set `CAO_DEBUG=1` only
when diagnosing the CLI itself and an internal stack trace is needed.

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
