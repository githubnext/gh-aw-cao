---
title: Monitor, Recover, and Maintain
description: Monitor control-plane runs, stop unsafe activity, recover from incidents, and maintain installed packages.
---

Use this page after installation to answer the urgent operator questions: Is the control plane healthy? How do I stop it? What evidence should I collect? How do I recover safely?

| Need | Start here |
| --- | --- |
| Check scheduled runs | [Routine monitoring](#routine-monitoring) |
| Investigate cancelled or incomplete work | [Queuing and resource exhaustion](#queuing-and-resource-exhaustion) |
| Stop one worker, one package, or everything | [Emergency stop](#emergency-stop) |
| Respond to an unsafe output or exposed credential | [Incident response](#incident-response) |
| Update an installed control plane | [Update CAO](#update-cao) |
| Add or update catalog workflows | [Maintain the catalog](#adding-a-package) |

For installation and the first write-free run, begin with [Install and run safely](getting-started.md).

```text
Is unsafe activity active or broadly possible?
	|
	+-- yes --> disable Actions, cancel runs, revoke credentials if needed
	|
	+-- no ---> disable one package or worker, collect evidence, resume in review
```

:::danger[Stop first when scope is unclear]
If shared control, authentication, or multiple packages may be affected, use the control-plane-wide emergency stop before investigating.
:::

## Validate Before Scheduled Live Runs

Before scheduled live operation, run one target through two manual checks:

1. `review`: set the worker `MAX_MODE` to `review`; verify the private review destination and no target writes.
2. `live`: set the worker `MAX_MODE` to `live`; use one low-risk target and verify the declared output and downstream CI.

Record both run URLs and restore the intended worker ceiling after the canary. A failed check disables the affected package and cancels its active runs until it can resume in `review`.

Use the same bounded profile in every gate:

```yaml
target_repo: acme/disposable-canary
max_repos: 1
rollout_percent: 100
expected_target_writes:
	review: 0
	live: declared outputs only
```

:::tip[Change one dimension at a time]
Keep the target and repository limits fixed while changing the mode. That makes routing differences attributable to the promotion gate rather than a different repository sample.
:::

The catalog source repository's `Review smoke` Actions workflow automates the first check for catalog maintainers. It is repository-only test tooling and is not installed by `aw.yml`. Run it manually, select one package, and provide one explicit `OWNER/REPO` target plus a private review repository. It dispatches that orchestrator with `max_repos: 1`, `rollout_percent: 100`, and `safe_output_mode: review`, waits for the orchestrator and correlated workers, and verifies that target issue and branch snapshots remain unchanged. It has no schedule and cannot request live processing.

The repository-only `Enterprise canary` Actions workflow automates both modes for catalog maintainers while keeping review and live deliberate:

1. Create repository environments named `central-agentic-ops-review` and `central-agentic-ops-live`. Require reviewers for both; restricting deployment branches to the default branch is recommended.
2. Add `GH_AW_E2E_TOKEN` to the environments when the built-in token cannot read the target/review repository or inspect cross-repository refs and issues. Scope it only to the dedicated canary repositories and required metadata, issues, pull requests, contents, and Actions access.
3. Use dedicated disposable target and private review repositories under an allowed owner. Never point review or live canaries at production repositories.
4. For review, enter `REVIEW OWNER/REPO` in `confirmation`; for live, enter `LIVE OWNER/REPO`.
5. Leave `require_output` false when a legitimate no-op is acceptable. Set it true only after preparing repository evidence that should deterministically produce a durable output. Review then requires a review-repository change; live requires a target-repository change.

The canary snapshots issues, pull requests (through the issues API), and branch refs before dispatch. Review must leave the target snapshot unchanged and may change only its private review destination; live may change only the dedicated target. Repository snapshots are a routing guard, not semantic approval of generated content, so operators must still inspect the output and correlation metadata.

The repository-only `Enterprise review stress` workflow sends only `2`, `3`, or `5` same-scope review runs and requires `STRESS OWNER/REPO RUNS` confirmation plus approval through the `central-agentic-ops-stress` environment. It routes outputs to an explicit private review repository, verifies that concurrency supersedes all but the newest run, and confirms that the target snapshot remains unchanged. Real stress remains manual because every run consumes AI Credits; `npm run test:load` supplies the CI-scale test with 100,000 synthetic repositories and no model calls.

## Routine Monitoring

Review the following for scheduled runs:

| Signal | Expected condition |
| --- | --- |
| Authentication | App token or PAT resolves without exposing credential data |
| Candidate selection | Targets match package discovery rules and configured limits |
| worker workflow eligibility | Installed worker workflows match and disabled worker workflows are skipped |
| safe output routing | review routes privately without target writes, and live targets the selected repository |
| Correlation | worker workflow safe outputs identify the orchestrator workflow run |
| safe outputs | Type, count, branch, files, and destination stay within declarations |
| Quality | safe outputs are actionable, non-duplicative, and supported by evidence |
| Cost | AI Credits and run volume remain within workflow limits and expectations |

List recent runs from the command line when correlating orchestrators and workers:

```bash
CONTROL_REPO="acme/central-agentic-ops"

gh run list \
	--repo "$CONTROL_REPO" \
	--limit 20 \
	--json databaseId,displayTitle,event,status,conclusion,url
```

With default one-repository caps, one Advisory orchestration is bounded by 850 AI Credits (250 for the orchestrator plus one 600-credit worker), one Dependabot orchestration is bounded by 850 AI Credits (250 plus one 600-credit worker), one AW Optimization orchestration is bounded by 1,900 AI Credits (250 plus one 350-credit auditor, one 500-credit optimizer, one 400-credit `AGENTS.md` curator, and one 400-credit skills curator), one EU CRA orchestration is bounded by 1,100 AI Credits (200 plus six 150-credit workers), one CAO Evolution orchestration is bounded by 2,550 AI Credits (250 plus three control-plane workers totaling 1,300 credits, one 500-credit failure investigator, and one 500-credit compiler-security worker), and one Dev Practices orchestration is bounded by 1,050 AI Credits (250 plus two 400-credit workers). The independent weekly Advisory package maintainer and daily CRA package maintainer are each bounded by 200 AI Credits. Declared dispatch ceilings keep deliberately expanded runs finite. These are hard worst-case envelopes, not expected consumption. Every workflow also has a timeout and same-scope concurrency cancellation.

### Run a Local AW Fixing Loop

The CAO Evolution compiler-security worker reports the exact compiler, validation, lint, image, and security-scanner findings that need remediation. To fix the same findings locally with a coding agent:

1. Install or update the extension with `gh extension install github/gh-aw` or `gh extension upgrade gh-aw`.
2. Configure the coding agent's MCP client to launch `gh aw mcp-server` over stdio with the target repository as its working directory.
3. Ask the agent to use the server's `fix` and `compile` tools, change workflow Markdown sources rather than generated lock files, and repeat the full validation command until it passes.

Use this command as the loop's acceptance check:

```bash
gh aw compile \
	--no-check-update \
	--strict \
	--validate \
	--validate-images \
	--models \
	--actionlint \
	--shellcheck \
	--yamllint \
	--zizmor \
	--poutine \
	--runner-guard \
	--grant \
	--grype \
	--syft
```

The container and image checks require a running Docker daemon. If a tool, image, or registry is unavailable, treat the result as incomplete rather than clean. Review the generated `.lock.yml` diffs after each successful compile, but make source changes only in `.github/workflows/*.md` and directly related files.

### Queuing and Resource Exhaustion

The control plane does not implement a durable work queue. GitHub Actions accepts workflow dispatches, while each orchestrator and each target-scoped worker uses `cancel-in-progress: true`: a newer same-scope run supersedes an older running or pending run instead of building an unbounded backlog.

API and budget failures are fail-closed:

- a discovery API failure, including rate limiting, produces no candidates and no worker dispatches, then an incomplete orchestrator report;
- a required control-source or workflow-resolution API failure stops precomputation before dispatch;
- a dispatch failure is recorded as deferred and is not retried within the same run;
- a worker that reaches an API limit, workflow AI Credit cap, or broader budget limit after startup stops additional work and reports incomplete without self-dispatch or a wait loop; if budget enforcement rejects startup, the failed Actions run is the audit record;
- work resumes only through a later scheduled run or an authorized manual run, which is a new bounded attempt. Each attempt checks live API capacity before rediscovering current candidates.

This favors bounded failure over eventual delivery. Scheduled, level-triggered operations reconcile current work rather than resume a prior process. One-off manual requests are not replayed, and guaranteed eventual processing is not provided by the current workflows.

Optional observability imports for Sentry, Grafana, and Datadog configure exporter destinations; they do not emit the dispatcher span or replace GitHub Actions run history and correlation metadata as the primary execution audit trail.

Every orchestrator emits a `central-agentic-ops.dispatcher.run` span after normalized agent output is available. Its attributes contain only the package, policy state, limits, and aggregate candidate, requested dispatch, target, workflow, and incomplete counts; target names, workflow inputs, run URLs, and error payloads are excluded. A `requested` status records dispatch intent before safe-output handlers call the GitHub API. Use gh-aw outcome spans and GitHub Actions run history to determine dispatch success or failure.

## Publishing Reviewed Operation Issues

The optional Ops Publish add-on turns an explicit human label into a deterministic issue publication without rerunning AI. It remains outside the Agentic Workflow package catalog: copy `ops-publish/ops-publish.yml` and `ops-publish/ops-publish.mjs` from a pinned catalog revision into the private repository that receives review issues.

Enable `control-plane.publishing` in `.github/workflows/cao.json`, declare its `reviewers` and optional `control-repositories`, and create the `ops:publish-to-target` label. Applying the label to an eligible bot-authored review issue validates the originating worker run, derives its target and package from trusted run metadata, enforces checked-in scope and target-owned package authority, creates the target issue with provenance, and closes the review issue.

This path supports issue outputs only. It does not transfer issues, publish pull requests or comments, or apply artifact-backed review bundles. GitHub issue transfer is not used because it is limited to repositories under one owner and cannot transfer a private issue to a public repository. See the add-on's `README.md` for installation, credentials, and failure behavior.

## Publishing Pages Reports

### Install the dashboard package

The root Central Agentic Ops package installs the deterministic activity index and dashboard by default. To install the dashboard without the operational workflows, install both focused deterministic packages from the same reviewed release tag or full commit SHA:

```bash
gh aw add githubnext/gh-aw-cao/activity@<catalog-release>
gh aw add githubnext/gh-aw-cao/dashboard@<catalog-release>
```

Both installation paths add an independently dispatchable dashboard builder, a manual standalone Pages publisher, and their deterministic report modules. There is no additional dashboard enable variable, and installation does not deploy or enable Pages.

:::note[Do not create `REPORT_PAGES_TOKEN`]
The dashboard does not use a `REPORT_PAGES_TOKEN` secret. Its build job reads report data with the automatic `github.token` and explicit job-scoped permissions. Its standalone deploy job uses GitHub Pages OIDC with `pages: write` and `id-token: write`. If an installed workflow requests `REPORT_PAGES_TOKEN`, it did not come from the current package and should be reviewed or updated rather than supplied with a PAT.
:::

:::caution[The report can contain private repository data]
The generated site includes data from its private control-plane repository, including repository identity, issue and pull request content, comments, artifact-derived summaries, workflow names and states, and run links. A private source repository does not by itself make its Pages site private. Configure Pages access control for the intended audience before the first deployment, and do not install this package when that boundary is unavailable.

Organization discovery excludes unrelated private repositories by default. `REPORT_INCLUDE_PRIVATE` is a boolean flag, not a credential, and there is no `REPORT_INCLUDE_TOKEN`. The current catalog workflow does not set the flag or accept a cross-repository credential, so it cannot discover unrelated private repositories out of the box.

A deliberate custom extension should mint a short-lived GitHub App token installed only on the selected repositories and grant `Metadata: read`, `Contents: read`, and `Actions: read`. The optional organization audit-log health query requires a compatible user token or fine-grained PAT with organization `Administration: read`; discovery continues without that health data when access is unavailable. Do not use a broad classic PAT.
:::

The package installs the following components in the control-plane repository:

- `.github/workflows/cao-dashboard.yml`, the dashboard builder, artifact publisher, and optional standalone Pages publisher;
- `.github/workflows/activity.yml`, the scheduled and manually dispatchable data collector and cache publisher;
- `.github/aw/activity/logs.mjs`, the single bounded `gh aw logs` acquisition entrypoint;
- `.github/aw/activity/index.mjs`, the local-only deployed-workflow and run-health indexer;
- `.github/aw/dashboard/report/aic-usage.mjs`, the bounded AI Credit usage collector;
- `.github/aw/activity/inventory.mjs`, the dependency-free control-plane inventory extractor;
- `.github/aw/dashboard/report/operational-values.mjs`, the fleet collector that invokes gh-aw history replay and falls back to recent run artifacts per workflow;
- `.github/aw/dashboard/report/operational-value-history.mjs`, the report-contract normalizer and append-only observation identity merger;
- `.github/aw/dashboard/report/records.mjs`, the durable issue, pull request, comment, and review-artifact normalizer with logs-derived run attribution;
- `.github/aw/dashboard/report/dashboard-language-sources.mjs`, the trusted adapter from collected records to Dashboard Language `sources.json`;
- `.github/aw/dashboard/site`, the packaged Dashboard Language configuration, validator, presenter, and browser runtime.

For a standalone Pages site:

1. In **Settings > Pages**, select **GitHub Actions** as the source and apply the required access controls.
2. Protect the `github-pages` environment as required by your organization.
3. Run **Central Agentic Ops Dashboard** from the repository's **Actions** page.
4. Verify the deployment URL and confirm that the report shows data only from the intended control-plane repository.

The standalone workflow passes `enablement: false` to `actions/configure-pages` and has no schedule. Set `control-plane.packages.dashboard.deploy` to `false` when an existing Pages workflow owns deployment. The dashboard workflow continues to publish `central-agentic-ops-dashboard`; the owning workflow can list successful `cao-dashboard.yml` runs on the default branch, download the latest artifact into its site output, and deploy the combined artifact.

The Activity workflow restores its log cache, runs one bounded `gh aw logs --audit --artifacts usage` command for compiled workflows in the checked-out control repository, and saves only the refreshed JSONL. It does not index, normalize, collect telemetry, or generate dashboard records. Consumers restore the JSONL cache and apply their own bounded processing without publishing secondary Activity cache files.

Target repository Git history, Actions run metadata, and accepted evidence are the reconstructable authority for operational value. gh-aw's local weekly shards and the installed control repository's Actions observation cache are accelerators, not archives; either may be deleted or evicted. The current Pages artifact is a presentation snapshot. No private organization-specific observation ledger belongs in the public catalog. Organizations that require an independently durable derived archive must persist the versioned observation records in an access-controlled control-plane data store and retain their source identity and evidence lineage.

Repository pages are outcome projections, not package projections. Reports and operational-value insights are grouped by their subject repository whether they were produced by a repository-local workflow or by a centrally executed worker. The report retains the producer identity `(runtime_repository, workflow_path)`, the durable output repository, and optional operation membership as separate provenance. Local Actions health and AI Credit usage remain labeled as local execution data; a central worker run is not counted as a target repository run.

Collection is bounded by the configured repository scope and available credentials. Inaccessible downstream repositories are reported as incomplete coverage rather than inferred from another source. Cross-repository private collection therefore requires the deliberately scoped GitHub App extension described above.

Report implementation changes are released through this catalog. Use `gh aw update` to refresh the installed workflows and report modules, then review, commit, and push the resulting changes.

Pages report destinations are selected by the control-plane mode, while conventional GitHub Actions workflows perform the builds and deployments:

| Mode | Published result |
| --- | --- |
| `review` | Access-controlled review Pages in the private `safe_output_repo`. |
| `live` | Production Pages. |

To operate a report publisher:

1. Confirm the required source records are durable, approved for publication to the selected review or production audience, and free of data that audience must not receive.
2. Confirm the effective mode and that review routes only to `safe_output_repo` while live routes only to the production destination.
3. Confirm the build used fixed trusted source locations and the expected source revisions. Trigger inputs must not select arbitrary repositories, paths, commands, or generated site bundles.
4. Review the build and deploy jobs, including accessibility and link checks, the protected environment approval when configured, and the resulting deployment URL.
5. Verify report freshness, provenance, project-path assets, representative desktop and mobile views, and a visible review or production identity.

Review Pages must be private and access-controlled for the intended reviewers. If the repository plan or policy cannot provide that boundary, review publication fails closed. Never publish review content to a public fallback site. Agents must not receive `pages: write`, `id-token: write`, or authority to promote review content to production.

Setting a package's checked-in `enabled` field to `false` prevents new package work after policy resolution but does not remove an already deployed site. Changing its policy mode from `live` to `review` redirects future publication to review Pages but does not unpublish production. To stop or roll back either site, disable its conventional Pages workflow, use its protected environment to block deployment, or redeploy a known-good source revision through normal repository procedures. Handle sensitive-data exposure as a Pages incident in addition to stopping the affected agentic package.

## Emergency Stop

Disabling GitHub Actions for the private control repository is the control-plane-wide stop. It prevents new orchestrator and worker runs from starting, including manual dispatches. A repository administrator, or an organization or enterprise administrator with authority over Actions policy, should:

:::caution[Package switches are not an all-stop]
A package kill switch is evaluated only after a workflow starts. It does not cancel active runs or block unrelated packages and workflows. Disable Actions and cancel active runs when a complete stop is required.
:::

1. Open the control repository's **Settings > Actions > General** and disable Actions for the repository. An organization or enterprise administrator may instead apply an Actions policy that disables the repository.
2. Cancel every queued or running orchestrator and worker run from the repository's **Actions** page. Disabling future execution does not replace canceling work that has already started.
3. Revoke the GitHub App installation or PAT when credentials may be exposed or when repository access must be removed independently of Actions execution.
4. Record the stop time, initiating administrator, reason, active correlation IDs, affected targets, and any safe outputs already created.
5. Verify that the control repository has no queued or in-progress runs and that no new run can be manually dispatched.

This is intentionally a GitHub-native administrative control rather than checked-in workflow policy. Policy is evaluated only after a workflow starts and therefore cannot be the authoritative stop for all execution.

The stop applies to one central control repository. In a deployment with an enterprise control repository and additional organization control repositories, an enterprise incident commander must identify and stop every participating control repository that falls within the incident scope.

There is no global workflow-level kill switch across independent control repositories. Keep the approved control-repository inventory available outside any one runtime so incident commanders can enumerate affected installations even when a repository is unavailable. For each affected runtime, disable Actions, cancel active runs, and revoke its credential independently.

Use narrower controls when a full stop is unnecessary:

| Scope | Control | Limitation |
| --- | --- | --- |
| One package | Set `control-plane.packages.<package>.enabled` to `false`, deploy the reviewed revision, and cancel active runs | Stops package work after policy resolution; does not cancel work already in progress. |
| One Orchestrator or worker workflow | Disable that workflow in GitHub Actions | Other enabled workflows can continue. |
| Repository credentials | Revoke the App installation or PAT | Does not itself prevent runs that can use another available credential. |
| Entire control plane | Disable Actions for the control repository and cancel active runs | Also stops unrelated Actions workflows in that repository. |

To resume after an all-stop:

1. Resolve the incident and rotate or narrow credentials when needed.
2. Set every installed package's checked-in mode to `review` and `enabled` to `false`.
3. Re-enable Actions for the control repository.
4. Re-enable one package, run one `workflow_dispatch` target with `max_repos: 1`, and verify routing, permissions, and safe outputs.
5. Promote each package independently through the normal review gates.

## Incident Response

For unexpected writes, unsafe routing, excessive dispatch, or credential concerns:

1. Use the [emergency stop](#emergency-stop) when the incident affects shared control, authentication, or multiple packages.
2. Otherwise, set the affected package or worker's checked-in `enabled` field to `false` and disable a specific worker workflow when the incident is worker-local.
3. Cancel active orchestrator and worker runs; mode changes do not alter runs already in progress.
4. Revoke or rotate credentials when exposure is possible.
5. Trace `correlation_id`, `central_repo`, and `control_plane_run_url` across safe outputs.
6. Record affected targets and safe outputs.
7. Revert or close safe outputs through normal repository procedures.
8. Fix and compile the affected workflows.
9. Resume with a one-repository review run before returning to live.

Capture enough evidence to reconstruct the boundary and the outcome:

```yaml
stopped_at: 2026-08-25T14:30:00Z
central_repo: acme/central-agentic-ops
bundle: optimization
correlation_ids:
	- optimization-2026-08-25-001
affected_targets:
	- acme/example-service
safe_outputs:
	- https://github.com/acme/example-service/issues/123
credential_action: app-installation-revoked
```

Do not include tokens, private keys, or secret values in the incident record.

If shared authentication or shared control caused the incident, perform the control-plane-wide emergency stop. Otherwise, preserve unaffected package operation.

## Update CAO

Update package-owned workflows and runtime resources through a reviewable update proposal. Keep `.github/workflows/cao.json` unchanged unless the release requires an explicit, separately reviewed policy migration.

From the control repository:

```bash
gh aw update --major --cool-down 0 --create-pull-request
```

The command updates the installed CAO package and opens a pull request containing its package-owned workflows, generated locks, ownership records, and immutable runtime source identity. Review that proposal as one atomic runtime revision. Parse `.github/workflows/cao.json`, reject unresolved placeholders, and run one bounded review target before restoring scheduled or live operation. Never edit generated `.lock.yml` files or `.github/aw/packages/*.json` ownership records by hand.

### Catalog Release Revocation

A catalog maintainer cannot remotely disable workflows already installed in independent control repositories. When a package release is unsafe:

1. publish the affected release or commit and a known-good replacement;
2. identify installations through package manifests and the approved control-repository inventory;
3. commit `enabled: false` for affected packages and cancel active runs in every installation;
4. revoke credentials when repository access must stop immediately;
5. pin or restore the known-good package revision, compile affected workflows, and validate one review target;
6. update projected catalog versions and lifecycle status after validation;
7. resume each runtime through review and limited-live promotion.

Removing or retagging the catalog source does not revoke installed files. Revocation is complete only after every affected runtime is stopped, repaired, or has its repository access removed.

## Adding a Package

A new package should:

1. Define an orchestrator with a schedule and manual inputs.
2. Add the package and its workers to the closed JSON schema and declare them in `.github/workflows/cao.json`; review remains the default mode.
3. Import `shared/control.md` as `role: orchestrator` with a static package identity and request-only narrowing inputs.
4. Pass the stable lowercase slug through shared control's `package` input and document the matching target-authority entry.
5. Keep GitHub tools read-only.
6. Declare only worker workflow dispatches as orchestrator workflow safe outputs.
7. Document discovery, ranking, dispatch, completion, and no-op behavior.
8. Start in review mode and complete all promotion gates independently.

## Adding a Worker

A new worker should:

1. Require the standard control envelope inputs.
2. Import `shared/control.md` as `role: worker` with the same stable package slug as its orchestrator.
3. Use a target checkout separate from the safe-output repository when needed.
4. Request minimum permissions, tools, network access, and AI credits.
5. Declare narrow safe outputs with explicit count, file, branch, and destination limits.
6. Avoid repository discovery and downstream dispatch.
7. Support review mode before live operation.
8. Be added to exactly the orchestrators that are allowed to dispatch it.
9. Receive a checked-in `max-mode` ceiling when its risk or maturity differs from its package peers.

## Change Validation

Control changes should be validated with the pinned minimum `gh-aw` version. Compile every executable workflow affected by shared imports, not only the directly edited file. Then check:

```bash
npm test
npm run test:load
npm run compile
npm run docs:build
git diff --check
```

- zero compile errors and warnings;
- no duplicated workflow-local authentication blocks;
- package manifests and docs agree on variables and modes;
- review and live routing remain fail closed;
- worker safe-output limits remain intact;
- `git diff --check` passes;
- compile-generated metadata is handled according to repository policy.

Do not promote a control change and a new high-risk worker to live in the same step. Validate shared policy first, then promote worker behavior separately.
