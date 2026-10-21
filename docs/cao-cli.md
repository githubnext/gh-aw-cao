---
title: CAO Commands
description: Configure and inspect CAO with the Go extension, and prepare evidence with the repository-local pipeline CLI.
agent:
  type: cli-reference
  prominent: true
---

Use this reference when operating CAO or adding a CLI command. The installer
downloads the compiled Go extension as `gh cao` and installs the Node.js runtime
for Activity and Dashboard Actions. Invoke it explicitly as
`node activity/cao.mjs <command>`; there is no shell launcher. Agents
using the CLI should follow the
[`cao-cli` skill](https://github.com/githubnext/gh-cao/blob/main/skills/cao-cli/SKILL.md);
agents querying activity data should use
[`analyze-cao`](https://github.com/githubnext/gh-cao/blob/main/skills/analyze-cao/SKILL.md).
The Go extension exposes the operator-facing command surface as `gh cao`.
Internal Node implementations remain for Actions and parity tests, not as an
alternative operator surface. Run policy commands from the control repository root:

```bash
gh cao --help
node activity/cao.mjs --help
```

Command failures exit nonzero and report the error without printing the command
reference. Request command-specific help with `gh cao COMMAND --help`.

## GitHub CLI extension

Install or refresh the extension together with the control-plane runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install.sh | bash
gh cao --version
```

### GitHub CLI release discovery

`gh extension install githubnext/gh-cao` currently fails because GitHub's
latest stable release, `v0.1.19`, contains only the CAO runtime archive and
its checksum, not extension binaries. Newer published prereleases contain
the binaries, but GitHub CLI first classifies the extension using
`releases/latest`, **before** selecting a `--pin` tag. Therefore
`gh extension install githubnext/gh-cao --pin v0.1.22` fails too.
There is intentionally no root executable script: CAO ships a standalone Go
binary, not a source-building or Node.js launcher.

Use the installer above from a control-repository checkout while the latest
stable release is runtime-only. Unlike GitHub CLI's discovery, it supports
published prereleases and verifies binary checksums and the embedded version.
It also installs the control-plane runtime; it is not an extension-only install.

Maintainers must publish a complete native-binary prerelease from the corrected
release workflow, then promote it through **Promote prerelease to latest** with
independent approval. Merging source changes alone does not repair the public
command. Do not modify an immutable historical release or promote a release
without its required validation evidence.

After a compatible release is latest, extension-only installs can use:

```bash
gh extension install githubnext/gh-cao
gh cao --version
```

These binary installs are managed by `gh extension upgrade gh-cao` (unless
pinned); they do not install the control-repository runtime or `gh-aw`.

### Control-plane installer

The installer registers `gh cao` directly in GitHub CLI's data directory,
following the gh-aw installer pattern, without requiring Go or a repository
rename. It honors `XDG_DATA_HOME` and Windows `LOCALAPPDATA`, defaulting to
`~/.local/share/gh/extensions/gh-cao`. Rerun the installer to update this
manually installed extension; `gh extension upgrade` does not manage it.
Linked/source installations are not overwritten. Release binaries use the
`gh-cao-OS-ARCH` naming convention (legacy releases use `OS-ARCH`), with `.exe` for Windows, and cover Linux,
macOS, and Windows on amd64 and arm64. `checksums.txt` contains their SHA-256
digests. Downloads fail closed unless the asset's exact checksum and embedded
version match. Verification finishes before replacing an existing binary.
An explicit catalog source `githubnext/gh-cao@vX.Y.Z` selects the same
extension tag, including a published prerelease with that tag; otherwise the
installer selects the latest published CAO `vX.Y.Z` release, including prereleases
but excluding drafts. Main/SHA and local catalog
sources still select their own runtime revision independently.
Node.js 24+ remains required for installing the repository's pipeline runtime,
but not for running the Go operator commands afterward.

For local development, build with `make build` and use `./gh-cao` directly, or follow the
[local extension installation guide](https://github.com/githubnext/gh-cao/blob/main/CONTRIBUTING.md#go-extension-development)
to invoke it as `gh cao`.

| Surface | Commands | Execution |
| --- | --- | --- |
| Policy and workflow controls | `init`, `campaigns mode`, `campaigns enable`, `campaigns disable` | Native Go; no Node runtime required. |
| Campaign installation | `campaigns add CAMPAIGN [GH_AW_ADD_OPTIONS...]` | Native Go; gh-aw owns installation records and workflow generation, Go materializes campaign resources and merges policy. No Node runtime required. |
| Onboarding and authentication | `setup`, `setup auth github-app\|enterprise-app\|token` | Native Go, preserving separate read/write credentials and explicit repository scope. |
| Lifecycle | `repos add OWNER/REPO`, `update`, `upgrade-gh-aw` | Native Go; gh-aw still owns workflow generation and campaign installation records. |
| Read-only analysis | `download`, `pages`, `queries`, `query-info`, `prompt`, `query`, `gh runs\|issues\|prs`, `computation intelligence\|runtime-health`, `mcp` | Native Go with pure-Go SQLite access and declarative Dashboard Language evaluation. |
| Workflow value | `value publish`, `value enable`, `value disable` | Publish prepared evidence to a hosted dashboard, or edit reviewed local policy for recurring collection of one workflow. |
| Installation diagnostics | `doctor`, `version` | Native Go. `doctor` checks GitHub CLI, gh-aw, authentication, and basic local policy structure and compiler pin. |
| Actions pipeline and maintainer tools | `discover-workflows`, `ingest`, `ingest-jsonl`, `audit-jsonl`, `compact-jsonl`, `recycle-cache`, `issue-status`, `hash-payloads`, `activity-stats`, `validate-activity-data`, `operational-value`, `cluster-problems`, `dashboard-complexity`, `prune-dashboard` | Invoke with `node activity/cao.mjs <command>`; not migrated to the extension. |
| Control-plane validation | `cao-validate.yml` | Actions-only JavaScript runtime; no Go or shell-wrapper command. |
| Node-only administration | `node activity/cao.mjs doctor`, `node activity/cao.mjs setup-auth hosted-cli` | SQLite check/repair and dedicated hosted-executor App creation; neither has an equivalent Go command. |

The extension is **entirely Go** and does not execute Node.js, npm, or installed
JavaScript modules. Its default reviewed dashboard catalog, canonical source
projections, and MCP contract are embedded from the same JSON documents used by
the dashboard. `pages`, `queries`, `query-info`, and definition-only `prompt`
work outside an installed control repository. Use `--dashboard FILE` to read
an explicit dashboard document and its directory-confined fragments.
`CAO_RUNTIME_ROOT` is no longer used by the extension.

Evidence queries read the canonical `__idb_records` projection through a
read-only SQLite connection; they do not run migrations or repair the snapshot.
Download evidence first with `gh cao download`, or pass `--database FILE` for
an explicitly prepared projection. Policy mutations still operate on the current
control checkout; the executable does not grant rollout authority.

```bash
gh cao init
gh cao setup
gh cao setup --repository 'my-monalisa-org/*'
gh cao setup auth github-app --help
gh cao setup auth enterprise-app --help
gh cao setup auth token --help
gh cao campaigns add githubnext/gh-cao/dependabot
gh cao repos add acme/example-service
gh cao campaigns mode preview dependabot
gh cao campaigns enable dependabot
gh cao campaigns disable dependabot
gh cao doctor --json
gh cao pages --json
gh cao query campaign-runs --param campaign=dependabot
```

All help works offline, including `gh cao setup --help` and
`gh cao campaigns --help`. Campaign controls are available only under
`campaigns` in the extension.
Repository enrollment uses `gh cao repos add OWNER/REPO`; the extension has no
root-level `add` command.
Authentication is grouped under `gh cao setup auth`; there is no root-level
`gh cao setup-auth` command. Run `gh cao setup` without a subcommand for guided
control-plane setup, or configure credentials independently with
`gh cao setup auth github-app`, `gh cao setup auth enterprise-app`, or
`gh cao setup auth token`. Each authentication profile retains its existing
options, dry-run behavior, credential prompts, and separate read/write scope.
After wildcard expansion, guided setup skips authentication prompts when every
repository (including the control repository) is confirmed public, using
Actions' built-in token for public-only monitoring. Review and public Pages
consent still require confirmation. Nonpublic or unknown visibility never
qualifies; lookup failures stop setup. For authenticated operations, use
`gh cao setup auth`. Its unattended monitoring shortcut is to repeat
`--repository OWNER/REPO` or pass a quoted `OWNER/*` to snapshot
currently public repositories. This public monitoring quickstart accepts a public Pages
dashboard; exact private/internal inputs fail. It enables no agent execution or
campaigns. Review and publish the resulting exact policy. Public evidence is
marked partial when logs/artifacts or authenticated enrichments cannot be
guaranteed; it is not reported as complete zero activity.
The dedicated hosted-executor App profile remains Node-only:
`node activity/cao.mjs setup-auth hosted-cli`.
The runtime JSON result for authentication retains `command: "setup-auth"`.
`gh cao setup auth token --help` also works offline. `campaigns add` and `update` retain
gh-aw option passthrough. JSON output, repeatable query parameters, stdin queries, interactive
secret prompts, and command exit codes retain their existing contracts.
There is no `gh cao run`: workflow execution still belongs to gh-aw.

Campaign installation fetches only the installed package's full `resolvedCommit`
SHA from the official catalog, or copies only Git-tracked campaign files from a
local catalog checkout. It replaces the selected campaign's resources, refreshes
its intelligence metadata, and merges declared workers while preserving existing
enablement, mode ceilings, campaign settings, and repository scope. It does not
reinstall the control-plane runtime or plugin. Missing policy is initialized for
the exact current control repository. Install the root package with `install.sh`,
not `gh cao campaigns add`; review and commit generated workflows and policy together.

`gh cao doctor` is deliberately **not** `node activity/cao.mjs doctor`: use the latter for
the existing SQLite snapshot check/repair operation. Neither Activity nor
Dashboard Actions is switched to the Go executable.

### Publish and refresh workflow value

Run the [operational-value skill](operational-value-how-to.md) first. It defines
the measurement contract and produces validated `*-evidence.jsonl`; publishing
does not collect evidence, run an evaluator or enable recurring work.

```bash
gh cao value publish github/gh-aw daily-file-diet \
  --server https://dashboard.example.com \
  --input daily-file-diet-pulse-evidence.jsonl
```

The server must support value publication and already contain the observed
repository and workflow. Hosted publication requires an authorized
administrator's current, stepped-up OAuth session: supply its cookie value in
`CAO_SERVER_SESSION` and its session-bound CSRF value in `CAO_SERVER_CSRF` through
your private credential environment. These are credentials; never put their
values in policy, report files, URLs, commits or shared command history.
`CAO_SERVER_TOKEN` is accepted only for a loopback server with PostgreSQL, not
as a remote PAT or hosted authentication fallback.

One original schema-v2 envelope is accepted, up to 8 MiB. The response confirms
its identity, original capture time and database revision. Exact retries leave
the revision unchanged. Stale captures, changed frozen contracts and rewritten
immutable measurements fail rather than replace accepted evidence.
Evidence timestamps use UTC and at most microsecond precision; finer nonzero
fractions are rejected rather than silently rounded.
Activity replacement retains directly published evidence. Local SQLite and
static Pages have no direct-publication endpoint; Pages uses Activity transport.

**Collection is wired automatically by the skill** once its frozen function and
repository-local recurring collector pass verification. It stages the exact
pair with `value enable ... --if-absent`, preserving existing registrations and
explicit disables. Review, commit and deploy those files to start collection.
For manual registration or an intentional re-enable, replace `COLLECTOR_PATH.mjs`
with that collector's actual path; an evidence file or renderer is not a
collector:

```bash
gh cao value enable github/gh-aw daily-file-diet --collector COLLECTOR_PATH.mjs
gh cao value disable github/gh-aw daily-file-diet
```

These commands edit local `.github/workflows/cao.json`; review, commit and deploy
that policy and collector together. They do not enable the measured workflow,
enroll repositories, upload executable code or immediately start a collection.
The existing Activity/hosted collection cycle refreshes only registered,
in-scope pairs when their frozen cadence is due. No new schedule or model call
is needed. A failed refresh retains the last accepted capture without changing
its timestamp or inventing a zero. Disable stops future collection, not history.
An explicit disable persists even if the skill is used again.
See the [collector contract](operational-value.md#recurring-collection-after-opt-in).

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
does not establish rollout authority or full schema validity; use the
[CAO validation workflow](#validate-the-control-plane) for full policy and workflow validation.

CAO and gh-aw have separate jobs:

- **`gh cao`** configures CAO policy, authentication, installed campaigns, workflow enablement, and queries evidence.
- **`node activity/cao.mjs`** prepares pipeline data and runs the retained Node-only tools.
- **`gh aw run`** starts a compiled agentic workflow.
- **`gh run`** lists, watches, and inspects the resulting GitHub Actions runs.

## Common Operator Loop

```bash
# Add a campaign and merge its workers into CAO policy.
gh cao campaigns add githubnext/gh-cao/dependabot

# Keep the campaign review-only and enable its workflows.
gh cao campaigns mode preview dependabot
gh cao campaigns enable dependabot

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

`gh cao campaigns mode preview` writes `mode: review` to `.github/workflows/cao.json`. The word *preview* distinguishes this operator command from a live promotion; campaign execution still reports `review` mode.

## Configure the Control Plane

| Command | Use it to |
| --- | --- |
| `gh cao setup` | Interactively choose repository scope, inspect visibility and ownership, and configure a compatible authentication profile. |
| `gh cao init` | Create a minimal review-safe policy when one does not exist. It refuses to overwrite an existing policy. |
| `gh cao setup admission --repo OWNER/REPO --url HTTPS_URL [--dry-run]` | Configure non-secret admission variables (OIDC requires no workflow secret); `--dry-run` previews changes. |
| `gh cao admission setup --repo OWNER/REPO --url HTTPS_URL [--dry-run]` | Configure repository admission variables for an already deployed authority; default audience is the URL and outage policy is `block`. |
| `gh cao admission status --repo OWNER/REPO [--json]` | Read effective admission settings, including repository overrides of inherited organization variables. |
| `gh cao admission disable --repo OWNER/REPO [--dry-run]` | Disable the cooperative gate by setting an empty repository URL, without deleting the override and reactivating organization defaults; `--dry-run` previews changes. |
| `gh cao setup admission --all-repos --url HTTPS_URL [--dry-run]` | Configure all repositories selected by the current control repository's validated global CAO scope. |
| `gh cao setup admission --org ORG [--org ORG...] --url HTTPS_URL [--dry-run]` | Configure organization defaults with visibility all, including future repositories; preserve repository overrides. |
| `gh cao setup admission --enterprise SLUG --url HTTPS_URL [--dry-run]` | Enumerate enterprise organizations and configure their organization variables, with enterprise read and per-organization Variables write access. |
| `gh cao setup auth github-app ...` | Configure organization-owned read and write Apps. |
| `gh cao setup auth enterprise-app ...` | Configure existing enterprise-owned Apps with policy-derived read scope and explicit `--write-repository` output scope. |
| `node activity/cao.mjs setup-auth hosted-cli ...` | Create the dedicated least-privilege App that the dashboard server's optional `execute-cli` worker uses for single-use, repository-scoped command tokens. |
| `gh cao setup auth token ...` | Configure explicitly consented owner-scoped fine-grained PAT pairs when an App is unavailable. |
| `gh cao campaigns add OWNER/REPO/CAMPAIGN` | Install one campaign and merge its declared workers into policy without broadening rollout or enabling live mode. |
| `gh cao repos add OWNER/REPO` | Verify GitHub CLI read access and stage one exact repository in local control-plane policy, with review-mode overrides for existing campaigns. |
| `gh cao deploy azure --plan --config FILE --template FILE --out FILE` | Review a fresh Azure Functions deployment without writing to Azure; `--apply --plan-file FILE` then repeats preflight and refuses change-set drift. See [Azure deployment](deployment-azure.md#native-fresh-deployment-command). |
| `gh cao update` | Upgrade gh-aw when required, update installed campaigns, and refresh worker declarations while preserving operator-owned settings. |
| `gh cao update --campaign SLUG` | Update exactly one installed campaign, retaining runtime materialization and worker-declaration refresh. Use `root` for the CAO root package. |
| `gh cao upgrade-gh-aw VERSION` | Install an exact gh-aw release, upgrade local Agentic Workflow files, and update the pinned policy version after the upgrade succeeds. |

### Update and enrollment details

Omit `--campaign` to update all installed CAO packages. Selection also works with
refs and update options, for example `gh cao update main --campaign dependabot`.
The slug is the last component of the installed package name (`root` for
`githubnext/gh-cao`). Unknown, ambiguous, empty, unsafe, or repeated selections
fail before updates or gh-aw upgrades. Campaign selection does not narrow a
required gh-aw compiler upgrade, which may refresh shared workflow files.

The canvas Updates page exposes **Add repository** beside Repositories. Its
debounced GitHub search only selects a target; execution still requires fresh
approval of the exact `gh cao repos add OWNER/REPO` command. Enrollment
requires existing exact owner and repository allowlists and does not rewrite a
broad discovery policy. An already enrolled repository is unchanged. New targets
stay in review mode even when a campaign defaults to live. The command neither
commits nor pushes, enables campaigns, changes rollout limits, configures
credentials, nor expands an explicitly narrowed Activity scope. Review and commit
the policy before activation at a reviewed workflow SHA.

### Setup and manual campaign execution

Use `gh cao setup` for review-before-apply configuration. Setup installs no
campaign, runs no workflow, and never commits or pushes. To add automation
afterward, follow the manual [Repo Assist walkthrough](repo-assist-quickstart.md)
using `gh cao campaigns add` and `gh aw run`.

Without an interactive terminal or when `CI` is set, `gh cao setup` applies
only the agent-safe public profile: exact current-repository read and Activity
scope, no campaigns, public Actions-backed Pages, and repository
`GITHUB_TOKEN` (`workflow-token`) authentication. It refuses private/internal
control repositories, broader existing policy, or installed campaigns.
`gh cao setup --json` returns the applied profile with
`"nonInteractive": true`. Bare installation remains usable before setup with
exact control-repository scope, no operational campaigns, and
repository-local workflow-token Activity access.

## Control Campaigns

```bash
# Map the campaign to review mode in policy.
gh cao campaigns mode preview dependabot

# Promote only after review and explicit approval.
gh cao campaigns mode live dependabot

# Enable or disable every installed workflow declared by the campaign.
gh cao campaigns enable dependabot
gh cao campaigns disable dependabot
```

These commands accept multiple campaign slugs:

```bash
gh cao campaigns disable dependabot repo-assist
```

`mode live` does not widen repository scope, grant target consent, or create credential access. Complete the [live rollout gates](rollout-and-routing.md) separately.
It also checks whether the control repository has a selected GitHub App or PAT with write credentials configured. If CI can confirm they are missing, it suggests `gh cao setup`; lack of permission to inspect Actions settings does not block the mode change. This check does not verify installation access or token permissions.

`disable` prevents new starts for the campaign's installed workflows. It does not cancel an active run or replace the [control-plane emergency stop](operations.md#emergency-stop).

## Validate the Control Plane

Control-plane validation is Actions-only. Publish reviewed configuration changes
to the control repository's default branch and inspect **CAO validation** in
Actions. To request another validation run:

```bash
gh workflow run cao-validate.yml
gh run list --workflow cao-validate.yml --limit 5
```

Validation checks the policy with the production resolver, the installed gh-aw compiler version, strict compilation and generated workflow drift, campaign workflow identity and enablement, `gh aw doctor`, and bounded trust-boundary security rules. GitHub workflow state is reported as unknown when API access is unavailable. Warnings do not fail the workflow by default.

The workflow invokes `node activity/cao.mjs validate --json` from the shipped
JavaScript runtime at the installed revision. This is the sole implementation;
`gh cao` does not expose `validate`. CI does not build or download
the Go extension or require consumer npm metadata. The internal runtime command
retains `--strict-warnings` for Actions callers that require warnings to fail.

Strict compilation runs against a committed temporary snapshot of the current
workflow files in the Actions checkout, without rewriting generated artifacts.

CI writes its JSON report under `RUNNER_TEMP`, outside the checkout, before
uploading the `cao-validation` artifact. This keeps report creation from
triggering a false `gh aw doctor` warning and validation issue on a fresh
installation. Download the structured report with
`gh run download RUN_ID --name cao-validation`.

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

## Operate the Hosted CLI Backend

The server binary includes a privileged operator interface for the hosted CLI
queue. Run it in the trusted executor environment with the same operational
store configuration as `execute-cli`:

```bash
cao-dashboard hosted-cli queue list --status queued --limit 50
cao-dashboard hosted-cli queue list --status queued --limit 50 \
  --continuation-token TOKEN_FROM_PREVIOUS_PAGE
cao-dashboard hosted-cli queue show COMMAND_ID
cao-dashboard hosted-cli queue cancel COMMAND_ID --actor OPERATOR_LOGIN
```

Queue output contains command summaries, not invocation values or process
output. List responses include `limit`, `hasMore`, and, when another page is
available, `nextContinuationToken`. Pass that opaque token to
`--continuation-token` with the same status filters to retrieve the next page.
The cursor follows command IDs and does not count or skip preceding rows.
Cancellation is an operator override that bypasses the dashboard
requester's live repository-permission check; it requires a durable audit store
and records the supplied operator login as a self-reported identity, not proof
of the caller's identity. Restrict database and executor environment access
accordingly. See
[Hosted CLI actions](../server/README.md#hosted-cli-actions) for the operator
workflow and SQLite debugging limitation.

For a single-worker development loop without a dispatcher, use
[Local Worker Debugging](local-debugging.md). Its request-only `debug` mode
is not a `gh cao campaigns mode` command or a campaign configuration.

CLI failures print one actionable message by default. Set `CAO_DEBUG=1` only
when diagnosing the CLI itself and an internal stack trace is needed.

## Inspect Activity

First download the JSONL shards and SQLite snapshot published by your deployed CAO dashboard:

```bash
gh cao download --url https://OWNER.github.io/CONTROL_REPO/cao/payload-hashes.json
```

The download remains local under `.cao/`. It is derived evidence, not rollout authority.
Use a trusted HTTPS source; redirects cannot downgrade HTTPS to HTTP.
For independent manifest integrity, pass `--manifest-sha256 SHA256` (or set
`DASHBOARD_MANIFEST_SHA256`) with a digest obtained through a separate trusted channel.
Checksums fetched alongside the snapshot detect corruption, not a compromised publisher
or TLS trust authority.

Use the gh-like query surface for common questions:

```bash
gh cao gh runs --repo OWNER/REPOSITORY --status failure --limit 20
gh cao gh issues --repo OWNER/REPOSITORY --since 2026-09-01
gh cao gh prs --repo OWNER/REPOSITORY --workflow WORKFLOW --limit 10
```

Check runtime health or query canonical records:

```bash
gh cao computation intelligence
gh cao computation intelligence --campaign dependabot --previous prior-intelligence.json --feedback decision-feedback.json
gh cao computation runtime-health --campaign dependabot
gh cao computation runtime-health --campaign dependabot --diagnose

gh cao query \
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
gh cao prompt cost-by-campaign
gh cao prompt campaign-runs --param campaign=dependabot --database .cao/gh-aw-logs.sqlite
```

Without `--database`, the command needs no downloaded snapshot and includes no evidence rows. With `--database FILE`, it executes the named query against that existing snapshot and includes a bounded preview; this does not grant rollout authority. Use `--dashboard FILE` to experiment with a different dashboard definition.

Run `node activity/cao.mjs doctor` to validate and repair the downloaded SQLite snapshot. This is different from `gh aw doctor`, which validates the workflow installation and repository setup.

## Evaluate and Evolve

The CLI also exposes evidence used to improve campaigns:

| Command | Purpose |
| --- | --- |
| `node activity/cao.mjs operational-value` | Compute campaign-specific value evidence from the canonical snapshot. |
| `node activity/cao.mjs cluster-problems` | Cluster bounded problem evidence emitted by installed campaigns. |
| `node activity/cao.mjs dashboard-complexity --input FILE [--database FILE]` | Rank Dashboard Language queries by estimated computation pressure. |
| `node activity/cao.mjs prune-dashboard --input FILE` | Report reusable, redundant, and unreferenced dashboard queries and views. |

Without `--database`, `dashboard-complexity` normalizes every canonical database table to weight one. With `--database FILE`, it weights tables by their deployed row counts (normalized to the largest table) read from that downloaded snapshot, giving a more realistic computation-pressure ranking.

Data-pipeline and dashboard-maintainer commands are listed by `node activity/cao.mjs --help`. For the full data workflow, see [Dashboard data ingestion](dashboard-data-ingestion.md#use-local-sqlite).

## Review What Each Command Changed

`init`, `campaigns add`, `update`, `upgrade-gh-aw`, and `campaigns mode` can change checked-in control-plane files. Review those changes and commit workflow sources, generated locks, and `.github/workflows/cao.json` together:

```bash
git status --short
git diff -- .github
```

Never edit generated `.github/workflows/*.lock.yml` files by hand. Never treat a successful command as permission to widen scope or enable live output.
