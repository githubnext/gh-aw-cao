---
title: Central Agentic Ops Data Acquisition Audit
description: Review of gh-aw log collection, GitHub API use, predownload, indexing, and caching.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Data Acquisition Audit

**Version:** 1.0.0  
**Status:** Working Draft  
**Audit date:** 2026-09-06 (refreshed)

**Refresh ledger:** See [Data Acquisition Audit History](./data-acquisition-audit-history.md) for compact dated refresh notes.

## Abstract

This informative audit inventories the repository's explicit `gh aw logs` calls and the related GitHub API, artifact-download, indexing, and caching paths. It identifies repeated collection and likely GitHub API rate-limit bottlenecks. Generated `*.lock.yml` files were inspected as manifestations but are represented by their editable Markdown or shared source.

## 1. Scope and method

The review covered production JavaScript and shell sources, editable workflow Markdown, conventional Actions workflows, graders, setup utilities, and cache consumers. Tests, examples, and generated lock files were checked for additional call patterns but are not counted as production acquisition paths. Browser fetches of the already-built `dashboard.json` and `sources.json` are included only as cache consumers; they do not call GitHub.

The inventory distinguishes:

- **collection**, which obtains GitHub state or gh-aw run data;
- **predownload**, which obtains data before an agent or renderer starts;
- **indexing**, which combines and normalizes collected data; and
- **caching**, which can avoid collection in a later step or run.

## 2. `gh aw logs` inventory

| Caller | Selection | Persistence | Observation |
| --- | --- | --- | --- |
| `.github/cao/src/control.mjs` (`applyMonthlyBudget`) | One month-to-date query for the orchestrator and each configured worker, up to 1,000 runs per workflow | None | Admission repeats the same package-wide usage scan on every orchestrator precompute when a monthly budget is enabled. Run IDs are deduplicated only after all workflow queries complete. |
| `dashboard/report/aic-usage.mjs` | One multi-target call for the workflows and run counts already selected by `activity/index.mjs`; two-day window | Temporary output unless `REPORT_AIC_CACHE` is set | The activity workflow does not set `REPORT_AIC_CACHE`, so the 15-minute collector normally redownloads the two-day gh-aw log set. `--cache-before -2d` does not create a cross-run cache by itself. |
| `.github/workflows/optimization-ai-credit-auditor.md` | Target repository, two days, at most 100 runs; locally filtered to the preceding 24 hours | `/tmp` for the current run | Overlaps the dashboard usage window and the evaluator's later evidence window. A separate API call first reads the current run's creation time. |
| `.github/workflows/optimization-ai-credit-optimizer.md` | Target repository, seven days, at most 50 runs | `/tmp` for the current run | Overlaps the auditor and dashboard collections. Monitoring workflows are filtered only after download. |
| `.github/graders/optimization-ai-credit-auditor-operational-value.sh` | Evaluator-defined before/after window, up to 10,000 runs | Evaluator temporary directory | Re-fetches evidence rather than consuming the worker's predownload, which is necessary for maturation but duplicates historical portions of earlier scans. |
| `.github/graders/optimization-ai-credit-optimizer-operational-value.sh` | Seven-day before/after evidence window, up to 10,000 runs | Evaluator temporary directory | Re-fetches overlapping target history for every evaluation or regrade. |
| `.github/graders/optimization-agents-md-curator-operational-value.sh` (formerly `ambient-context-agents-md-curator-operational-value.sh`) | Thirty-day before/after evidence around an applied change, up to 10,000 runs | Evaluator temporary directory | Potentially the largest retained-log window and repeated for regrades. |
| `.github/workflows/agentics-maintenance.yml` | Repository activity report, one week, up to 500 runs | Actions cache under `.cache/gh-aw/activity-report-logs` | This conventional maintenance workflow maintains a separate gh-aw log cache and does not reuse the CAO activity snapshot. |

All bounded production log collectors except monthly budget admission reserve 2,000 GitHub API requests through `--max-github-api-rate-limit -2000`. This is fail-closed protection, not shared coordination: concurrent collectors using the same credential can each begin work and then independently stop at the reserve.

`gh aw forecast` in the auditor and `agentics-maintenance.yml`, and `gh aw graders operational-value report` in `dashboard/report/operational-values.mjs`, may read or build gh-aw log caches internally. They are not additional literal `gh aw logs` calls, but they overlap the same run-history domain and must be considered when measuring actual API traffic.

## 3. GitHub API and predownload inventory

### 3.1 Shared control path

| Source | Requests and behavior | Existing mitigation |
| --- | --- | --- |
| `.github/workflows/shared/control.md` | A sparse, shallow `actions/checkout` of `.github/cao/src` at `github.workflow_sha` replaced the earlier pair of Contents API reads for `control.mjs` and `policy.mjs`. Every importing workflow execution still performs one exact-SHA checkout before activation. | Exact-SHA provenance is preserved; the checkout uses `fetch-depth: 1` and cone-mode sparse paths, avoiding the two separate Contents API requests previously issued per run. No shared artifact or cross-run checkout reuse exists in this job. |
| `.github/cao/src/control.mjs` | Reads rate limits, policy and target-authority files, repository metadata, workflow inventory, repository inventory pages, safe-output metadata, and target commits. Also checks runner free disk space before repository discovery (no API calls). Admission now additionally writes a local `admission.json` record (repository, workflow, run, package, role, checks, and any capacity observations already read) to the job-local `RUNNER_TEMP/cao` directory. | `gh api --cache 60s` for helper reads, a capacity check before precompute, bounded repository pages, and clean rate-limit denial. The cache is job-local and short-lived. The new admission record is a local file write of already-collected data, not an additional GitHub API request. |

The former two-request Contents API bootstrap in `shared/control.md` has been replaced by a single git checkout step; this is no longer a Contents API cost per run, though it still runs once per importing workflow execution before the in-process 60-second CLI cache can help. Compiled lock files repeat this shared implementation but do not represent extra calls beyond the workflow executions themselves.

`control.mjs` now also supports an advisory, cross-run GitHub API capacity gate. When admission or precompute observes insufficient core-request capacity, `shared/control.md` mints a short-lived write-scoped app token and runs `control.mjs persist-api-gate`, which reads then writes a `CAO_GITHUB_API_GATE` repository Actions variable (one `gh api` GET plus one `gh api` PATCH or POST per persisted gate) recording the observed limit, remaining count, and reset time. Later admission runs read that variable (`vars.CAO_GITHUB_API_GATE`, no API call) via `githubApiGateCapacity`, and skip the direct `gh api rate_limit` probe entirely when the gate is still active and unexpired. This trades one still-live-until-reset rate-limit read for a small write cost per persisted gate, but removes the redundant `rate_limit` read from every gated run underneath a shared, cross-workflow throttling window; the gate is validated for `version`, `reason`, and a bounded two-hour future `reset` before being trusted.

### 3.2 Activity and dashboard path

| Source | Requests and behavior | Existing mitigation or gap |
| --- | --- | --- |
| `activity/index.mjs` | Uses direct REST calls for Pages privacy, code search, workflow registries, repository metadata and trees, manifest/source/lock contents, organization counts, Actions runs, failed-run jobs, and latest gh-aw release. | Reuses a prior complete index and refreshes run history with a one-hour overlap. Requests are bounded and concurrency-limited. Code search has a separate, much smaller quota; size partitioning can multiply searches. Repository metadata and workflow source data are not persisted independently. Run-record retention logic was extracted to `activity/run-health-snapshot.mjs`: `previousIndexCanRetainRuns` now lets a partial or scope-widened refresh still carry forward in-window run records from the prior snapshot (via `previousRunRecords`), separately from the stricter `previousIndexIsReusable` check that gates skipping new collection outright. This avoids losing already-collected run history on partial refreshes but does not by itself add or remove API calls. |
| `activity/github-telemetry.mjs` | Runs `gh api rate_limit` (one request) immediately before and after each of the four activity phases (`refresh-activity`, `collect-aic-usage`, `collect-operational-values`, `collect-dashboard-records`), appending rate-limit and activity-cache-hydration snapshots to a job-local JSONL ledger (`$RUNNER_TEMP/cao-gh/cao-gh.jsonl`). Each entry now also carries a normalized, bounded call-stack (`GITHUB_TELEMETRY_STACK_TRACE_LIMIT`, 24 frames) captured via `defaultGithubTelemetryStackTrace`/`normalizeGithubTelemetryStackTrace`, so the dashboard telemetry view can attribute a probe to its calling phase. | Purely observational instrumentation, not a mitigation for request volume. Still adds up to 8 extra core-quota `rate_limit` requests per activity run (an endpoint that itself has a very high, separately-tracked allowance) to attribute request consumption per phase; the added call-stack field is additional per-entry metadata, not an additional request. The ledger is no longer discarded each run: `activity.yml`'s "Restore recent GitHub API telemetry" step now runs `github-telemetry.mjs prepare` against the previous run's `cao-gh.jsonl` inside the restored `cao-activity` cache, keeping only entries within a rolling `GITHUB_TELEMETRY_RETENTION_HOURS` (24h) window before the current phases append more entries; the trimmed ledger is copied back into `cao-activity` and also uploaded as the separate `cao-gh` artifact (30-day retention) at the end of the run. |
| `dashboard/report/records.mjs` | For every report repository, fetches up to ten pages each of all issues and issue comments, the first 100 Actions artifacts, and run metadata referenced by outputs. | Promise memoization deduplicates run metadata only within one process. A prior snapshot is retained on rate limit, but successful runs always rescan issue/comment history and artifact metadata. The artifact list is not paginated, so traffic is bounded at the cost of incomplete results beyond 100 artifacts. Issue bodies now also carry a `gh-aw-workflow-id` marker that lets bundle/workflow attribution be resolved from the already-fetched issue body instead of an extra run-metadata lookup, but this only reduces per-record work when the marker is present; it does not change the fetch pattern above. |
| `dashboard/report/operational-values.mjs` | Runs one operational-value report per eligible workflow. If unsupported or failed, downloads the `agent` artifact separately for each uncached fallback run and may regrade due observations. | Persistent observation and replay caches avoid already-observed fallback runs. Report collection still performs per-workflow history work, and artifact fallback has no batch API. |
| `dashboard/dispatch-workflow.mjs` | Dispatches activity/dashboard workflows and polls every five seconds until discovery and completion. | The dispatch response can eliminate discovery polling when it contains run details. Completion polling still has no ETag or backoff between requests; a 120-minute run can make about 1,440 status requests. A 403 rate-limit response now short-circuits into a `skipped` output that the calling workflow (`dashboard/dashboard.yml`, `.github/workflows/dashboard-build.yml`) uses to skip the downstream build/pages job, so a rate limit stops the chain instead of failing partway through a build. |
| `dashboard/local-server.mjs` | Reads repository default branch, finds the latest dashboard-data artifact, validates its run, then downloads that artifact before serving. | One startup predownload and no repeated polling. There is no local reuse between server starts. |
| `.github/workflows/self-care-dashboard-review.md` (live-mode prefetch) | Direct `gh api` calls for default branch, one unpaginated 100-item artifact list, and run provenance, followed by `gh run download` of the dashboard artifact; the agent then separately queries the workflow registry and the latest 100 runs from the last 24 hours through its own `gh-proxy` toolset. | Bounded per-call limits and a trusted-provenance check exist, but this predownload and history query are independent of `activity/index.mjs` and `records.mjs`; every dispatch re-discovers the same artifact and run metadata rather than reusing the `cao-activity` snapshot. |
| `.github/workflows/activity.yml` and `.github/workflows/dashboard-build.yml` | Activity produces one coherent cache snapshot; the builder restores it and does not recollect. | Correctly centralizes dashboard collection. A live dashboard dispatch still forces an activity refresh even when the scheduled snapshot is fresh. |

### 3.3 Workflow prefetch and grader paths

| Source family | API pattern | Rate-limit concern |
| --- | --- | --- |
| `.github/workflows/aw-doctor.md` (formerly `aw-maintenance.md`) | GitHub Script reads latest release, repository trees and manifests, open issues, commits, and recent workflow runs. | Per-target prefetch repeats latest-release lookup and repository scans. |
| `.github/workflows/aw-maintenance-upgrade.md` | GitHub Script paginates gh-aw releases and searches target issues before agent execution. | A 24-hour Actions cache avoids most release-list calls; target issue search remains per run. |
| `.github/workflows/optimization-agents-md-curator.md` and `optimization-skills-curator.md` (formerly `ambient-context-agents-md-curator.md`/`ambient-context-skills-curator.md`, consolidated under the `AW Optimization` package) | Lists open pull requests, then lists files or review comments for bounded candidate pulls. | N+1 per-pull requests; bounds limit the worst case but no shared target snapshot exists. |
| `.github/graders/optimization-agents-md-curator-operational-value.sh` | Paginates evidence issues and target pull requests, then reads files for candidate pull requests before collecting logs. | Full issue/PR pagination is repeated for each evaluation. |
| `.github/graders/dependabot-release-train-updater-operational-value.sh` | Reads branch protection, the producer run, all target pull requests, files for candidates, pull details, check runs, and commit status. | The per-candidate files/pull/check/status sequence is the largest shell N+1 pattern. |
| `.github/graders/optimization-ai-credit-auditor-operational-value.sh` | Paginates evidence-branch commits, then reads a full recursive tree and one blob before log collection. | Repeated tree traversal for snapshots that could be addressed directly if the path/commit were recorded. |
| `.github/graders/aw-failures-investigator-operational-value.sh` and `self-care-docs-build-time-investigator-operational-value.sh` | Read bounded Actions workflow-run pages. | Explicit page bounds keep these predictable; each evaluator invocation still starts cold. |
| EU CRA and software-development-practices graders/runtime copies | Read issues and reactions; EU CRA also reads ledger contents, commits, associated pulls, and reviews. | Package source and installed runtime copies are intentional duplication of code, not simultaneous calls. Evaluations repeat repository history without a shared evidence cache. |
| `.github/workflows/design-decision-gate.md` | Per pull-request event: one `gh pr view` (json fields), one paginated `gh api .../pulls/{n}/files`, and conditionally one `gh pr diff` (skipped above 300 files). | Prefetch is a single bounded step per triggering event with an explicit diff-size cutoff; no cross-run cache or reuse of a prior gate's fetched files/diff for the same pull request. |
| `.github/workflows/mattpocock-skills-reviewer.md` | Per `ready_for_review` event or `/matt` slash command: one `gh pr view`, one `gh pr diff` (truncated to 3,000 emitted lines, excluding lock/dist/build paths), and one paginated `gh api .../pulls/{n}/comments`. | Diff line-cap and path exclusion bound payload size, but repeated slash-command invocations on the same pull request re-fetch the same metadata, diff, and comments from scratch. |
| `.github/workflows/pr-sous-chef.md` | Every 30 minutes (or on `/souschef`): one `gh pr list` across up to 50 open, non-draft pull requests with rollup status fields; the prompt additionally directs "bounded, paginated reads" for checks/review threads on a shortlisted candidate; each selected candidate now also triggers a full `fetch-depth: 0`/`fetch: ["*"]` checkout of the entire repository history to check out the candidate's head branch for fixing. | The list call is a single bounded request per run, but scheduling every 30 minutes rescans the full open-PR queue each time; there is no persisted watermark of previously nudged or already-evaluated pull requests. The workflow was redesigned from an advisory nudge (posting a comment) to fixing blockers and pushing commits via `push_to_pull_request_branch`, which is a new git-history acquisition path (full unshallow clone) not present in the earlier advisory design. |
| `.github/workflows/self-care-open-source-failures.md` | Restores the same `cao-activity` Actions cache used by the dashboard and reads only its persisted `deployed-workflows.json` snapshot; issues remediation issues via the `issues: read` toolset without additional API calls in the prefetch step. | No new GitHub API collection: this worker is a pure consumer of the existing activity snapshot and fails closed (`incomplete`) when the snapshot is missing, stale, or does not cover a full seven-day run-health window. |
| `.github/workflows/self-care-dashboard-performance.md` | Runs Lighthouse/Playwright audits against the built dashboard site; persists only a local round-robin rotation state file (`/tmp/gh-aw/cache-memory/dashboard-performance-rotation.json`, capped at 30 entries) and uploads a run evidence artifact. | No `gh aw logs` calls and no direct GitHub API/REST/GraphQL requests in prefetch or evaluation; no operational-value grader exists yet for this worker, so it adds no new collection or N+1 acquisition path. |

Administrative setup (`.github/cao/setup-github-apps.mjs`), release workflows, CI checks, and e2e scripts also use GitHub APIs. They are interactive or repository-maintenance traffic rather than operational collection, but they share the caller's quota and should not be scheduled concurrently with large audits when they use the same token.

## 4. Cache and index topology

| Cache or index | Producer | Consumer | Reuse boundary |
| --- | --- | --- | --- |
| `cao-activity-*` Actions cache | `.github/workflows/activity.yml` | Next activity run and dashboard builder | Complete collection snapshot; latest matching key across runs |
| `deployed-workflows.json` incremental run index | `activity/index.mjs` | Activity collectors | Reuses complete run records with a one-hour overlap; other discovery data is refreshed |
| gh-aw AIC output directory | `dashboard/report/aic-usage.mjs` | The same process | Normally temporary in the activity workflow |
| Operational-value observations and replay | `dashboard/report/operational-values.mjs` | Later activity runs and gh-aw grader reports | Persistent Actions cache |
| `records.mjs` run map | `dashboard/report/records.mjs` | The same process | In-memory only |
| gh-aw release list | `aw-maintenance-upgrade.md` | Later upgrade runs | 24-hour file cache restored by Actions cache |
| Maintenance activity and forecast logs | `agentics-maintenance.yml` | Later maintenance runs | Separate Actions caches, outside the CAO activity snapshot |
| GitHub API telemetry ledger (`cao-gh.jsonl`) | `activity/github-telemetry.mjs` | Next activity run's dashboard quota history and the `cao-gh` artifact | Rolling 24-hour window retained inside the `cao-activity` cache; trimmed on restore by `prepare`, not a fresh discard per run |
| Dashboard source document | Dashboard browser | Later page loads | IndexedDB keyed by the `sources.json` URL; stale data is displayed while live static data loads |
| Dashboard data artifact | Dashboard build | Local server | Predownloaded once per local-server start; no local persistence contract |

The activity snapshot is the intended shared collection boundary. The main gap is that gh-aw AIC logs are stored under a temporary directory while the snapshot persists only the derived `aic-usage.json`; graders and workers cannot reuse the retained raw log material.

## 5. Duplicate work

1. **Run history is collected by multiple independent systems.** `activity/index.mjs` collects Actions run metadata, `aic-usage.mjs` downloads gh-aw logs, operational-value reports replay workflow history, worker predownloads collect overlapping target logs, and graders later collect overlapping evidence windows.
2. **Monthly budget admission rescans package history per execution.** Each budgeted orchestrator run invokes `gh aw logs` once per package workflow even when another run recently computed the same month-to-date total.
3. **Dashboard durable records rescan stable history every 15 minutes.** Issues and comments are fetched from the beginning, rather than incrementally from the previous snapshot's newest update.
4. **Control bootstrap still runs once per workflow run.** The exact-SHA runtime files are now obtained via one sparse, shallow git checkout instead of two Contents API reads, but each importing run still repeats this checkout independently before the helper's CLI cache exists.
5. **Repository metadata and source content are rediscovered.** The activity index persists normalized results but not reusable ETags or per-resource responses, so unchanged registries, trees, manifests, Markdown, and lock metadata consume requests again.
6. **Per-candidate grader requests create N+1 traffic.** Dependabot and AW Optimization (formerly ambient-context) evaluators enumerate broad candidate lists and then query files, checks, statuses, or comments one candidate at a time.
7. **Separate maintenance caches overlap the activity cache.** `agentics-maintenance.yml` stores independent activity/forecast log trees that cannot satisfy CAO dashboard or grader collection.
8. **Telemetry probes now persist across runs.** `github-telemetry.mjs` issues a fresh `gh api rate_limit` call before and after each activity phase, independent of the capacity check already performed by `control.mjs` admission/precompute and independent of the persisted API gate. Its ledger is retained for a rolling 24-hour window through the `cao-activity` cache (rather than deleted each run), so historical rate-limit/cache-hydration entries now survive across scheduled runs for dashboard trend rendering, but the per-run probe count itself is unchanged.
9. **New per-event PR automation prefetch is not shared across workflows.** `design-decision-gate.md` and `mattpocock-skills-reviewer.md` each independently fetch `gh pr view`, a diff, and paginated files or review comments for the same pull request on overlapping trigger events (e.g. `synchronize` and `ready_for_review`); neither consumes the other's prefetched evidence, and repeated slash-command re-invocation of `mattpocock-skills-reviewer.md` re-fetches identical metadata each time.
10. **`pr-sous-chef.md` polls the full open-PR queue on a fixed schedule.** Every 30 minutes it re-lists up to 50 open, non-draft pull requests with status-rollup fields regardless of whether anything changed since the previous run, and it has no persisted watermark to skip already-evaluated candidates. It was also redesigned from a comment-only advisory nudge to a code-fixing worker that checks out each selected candidate's branch with a full (`fetch-depth: 0`, `fetch: ["*"]`) clone and pushes commits via `push_to_pull_request_branch`, adding a new full-history git acquisition cost per selected candidate that did not exist in the prior advisory design.
11. **`self-care-dashboard-review.md` maintains its own artifact/run discovery path.** Its live-mode prefetch independently calls the artifacts and runs APIs and downloads the dashboard artifact, duplicating metadata already collected by `activity/index.mjs` and `records.mjs`; it does not reuse the `cao-activity` snapshot, so every dispatched review re-discovers the same current artifact and recent run history from scratch.

## 6. Rate-limit bottlenecks

| Priority | Bottleneck | Why it matters |
| --- | --- | --- |
| P0 | Five-second workflow completion polling | One long dashboard chain can consume more than a thousand core requests despite doing no new collection work. Multiple dispatchers multiply this linearly. A 403 rate-limit response is now detected and short-circuits the chain (skipping build/pages), which bounds the *failure* cost but does not reduce the request volume of a normal successful run. |
| P0 | Organization code-search partitioning | Authenticated code search has a much lower rate limit than the core REST API. A large organization or partitions still exceeding 1,000 results can exhaust it before ordinary collection begins. |
| P1 | Cold, full issue/comment scans in `records.mjs` | Up to 20 core requests per report repository every 15 minutes, before artifact and run lookups. The cost grows linearly with enrolled repositories. |
| P1 | Repeated `gh aw logs` windows | Dashboard, budget, workers, reports, and graders independently download overlapping Actions/log/artifact data. The 2,000-request reserve causes partial data sooner when they share a credential. |
| P1 | Per-workflow monthly budget scans | Request cost grows with enabled worker count and orchestrator frequency, while the result changes only when package runs finish. |
| P1 | Grader N+1 queries | Pull-file, pull-detail, check-run, status, tree, and blob calls grow with candidates and with every regrade. |
| P2 | Repeated control checkout | One sparse checkout per run is small but still multiplied by every controlled workflow execution; it no longer costs two Contents API requests. |
| P2 | Cold artifact discovery | `records.mjs` and the local server list artifacts independently; operational-value fallback downloads one artifact per run. |
| P2 | Per-phase telemetry rate-limit probes | Up to 8 additional `gh api rate_limit` reads per activity run beyond the admission/precompute capacity check and the persisted gate; low absolute cost against the separate `rate_limit` allowance, but still avoidable duplication. The ledger is now retained 24h via the activity cache, so the historical dashboard view no longer needs a fresh full-window probe count each run, but the per-run request volume is unchanged. |
| P2 | Duplicate per-PR review prefetch | `design-decision-gate.md` and `mattpocock-skills-reviewer.md` independently re-fetch the same pull request's metadata, diff, and paginated files/comments on overlapping trigger events; low per-event cost but grows with pull request activity and slash-command reuse. |
| P2 | Fixed-schedule PR queue polling | `pr-sous-chef.md` re-lists up to 50 open pull requests every 30 minutes regardless of change, with no persisted watermark; each fixed candidate now also incurs a full unshallow git checkout. |

The direct activity client retries 403 and 429 responses only when the advertised delay is at most 30 seconds. `records.mjs` instead stops on a confirmed rate limit and retains the prior snapshot. Dispatch polling and most GitHub Script or shell clients have no common rate-limit response policy.

## 7. Recommendations

1. **Replace fixed completion polling with bounded backoff.** Start at the current responsive interval, increase it for long-running jobs, honor `Retry-After` and rate-limit reset headers, and prefer returned run details to discovery polling. **(Partially addressed:** `dispatch-workflow.mjs` now detects a 403 rate-limit response and emits a `skipped` output so `dashboard/dashboard.yml` and `dashboard-build.yml` skip the downstream build/pages job; the fixed five-second interval and lack of proactive backoff on successful polling remain.)
2. **Make the activity snapshot the reusable run-data boundary.** Persist a bounded raw gh-aw log cache beside derived AIC data, with repository, time-window, completeness, and credential-scope metadata. Permit consumers to reuse it only when those bounds satisfy their request.
3. **Increment durable-record collection.** Retain per-repository update watermarks, request only changed issues/comments, and periodically perform a bounded reconciliation scan. Preserve the prior snapshot when completeness cannot be proven.
4. **Cache month-to-date package usage.** Key it by package workflow set, repository, month, and latest observed run ID; invalidate it when the activity index observes a newer relevant run. **(Partially addressed for capacity checks:** the new `CAO_GITHUB_API_GATE` repository variable lets admission/precompute skip a redundant `rate_limit` probe when a recent run already recorded insufficient capacity; it does not cache month-to-date budget totals.)
5. **Reduce activity discovery calls.** Persist ETags or immutable blob SHAs for registry, tree, manifest, Markdown, and lock data. Avoid repository metadata rereads within one process and prefer allowlist discovery over organization code search where policy already supplies the scope.
6. **Batch or narrow grader evidence.** Record immutable evidence identifiers during the producer run, query candidates by time where supported, and reuse one evaluation-local repository snapshot across graders. Keep existing fail-closed completeness rules.
7. **~~Bundle exact-SHA control runtime files.~~ (Implemented)** Control bootstrap now uses one sparse, shallow checkout instead of two Contents API calls, preserving the exact-SHA workflow provenance boundary. Remaining opportunity: avoid repeating this checkout across concurrently running importing workflows when feasible.
8. **Instrument request budgets.** Emit request counts by endpoint family, cache hit/miss, pages read, downloaded bytes, remaining core/search quota, and incomplete reason. Use this evidence before changing concurrency or reserve thresholds.
9. **Do not merge caches solely by repository.** Cache keys must retain token/installation scope, private-data policy, exact source SHA where relevant, requested time window, and completeness. A cache hit must never widen repository authority or publish private data.
10. **Fold telemetry probes into existing capacity checks.** `github-telemetry.mjs`'s per-phase `gh api rate_limit` calls duplicate the admission/precompute capacity read and the persisted gate; record the already-obtained rate-limit response instead of re-querying it, or reduce probe frequency to once per run. **(Partially addressed:** the ledger is now retained 24h across runs via the activity cache instead of being deleted each run, which fixed the dashboard's quota-history rendering gap, but the per-run probe count is unchanged.)

## 8. Suggested implementation order

1. Back off dashboard dispatch polling and add request-count telemetry.
2. Increment `records.mjs` issue/comment collection.
3. Persist and reuse bounded gh-aw logs through the activity cache.
4. Cache month-to-date budget totals against observed run IDs.
5. Narrow grader N+1 evidence lookups.
6. Optimize control bootstrap only after preserving exact-SHA and fail-closed behavior in tests. **(Done: bootstrap now uses a sparse git checkout instead of Contents API reads.)**

These changes should be delivered separately. This audit records current behavior and does not itself change collection, authority, credentials, or cache semantics.
