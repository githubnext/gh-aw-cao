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
**Audit date:** 2026-09-09 (refreshed: `activity/logs.mjs` now requests the `agent` artifact family in addition to the existing bounded set, so per-run agent transcripts are downloaded rather than excluded; `dashboard/report/aic-usage.mjs` adds `readRunTimeline`, which reads `gateway.jsonl`, `rpc-messages.jsonl`, firewall `audit.jsonl`, and `copilot-session-state/*/events.jsonl` from the already-downloaded run directory and feeds a new canonical session/event ingestion pipeline (`dashboard/site/src/data/adapters/gh-aw-logs.js`, IndexedDB-backed). This is additional local processing of existing predownloaded artifacts, not a new GitHub API call. Earlier refresh: `activity/logs.mjs` adds per-run Jobs API collection for runs lacking complete job data or not yet completed; completed runs with a matching cached attempt are reused. `dashboard/report/records.mjs` adds uncached repository visibility/default-branch scans and remote workflow commit/contents lookups, blob-SHA-cached raw lock downloads, and one `GET /repos/github/gh-aw/releases/latest` call per run whenever remote workflow repositories are enrolled.)

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
| `activity/logs.mjs` | One call for all compiled workflows checked out in the control repository; 30-day security-evidence window | Raw JSON, collection state, and downloaded artifacts in the shared `cao-activity` cache | Runs immediately after cache restore with bounded usage, detection, evaluation, experiment, firewall, GitHub API telemetry, grader, and MCP artifact sets. **Changed:** the `agent` artifact family is now also requested (`--artifacts usage,detection,evals,experiment,firewall,github-api,graders,mcp,agent`), so heavy per-run agent transcripts are downloaded rather than excluded, increasing artifact-download size per run. AI Credit, security, operational-value, and index collection process the same snapshot; `dashboard/report/aic-usage.mjs`'s new `readRunTimeline` additionally reads `gateway.jsonl`, `rpc-messages.jsonl`, firewall `audit.jsonl`, and `copilot-session-state/*/events.jsonl` from the already-downloaded run directory to feed a canonical session/event data model (no new GitHub request; local processing only). When `gh aw logs` fails, the Actions fallback lists runs once per compiled workflow target (4-way concurrency). `collectJobDetails`/`runGhJobsApi` requests `GET repos/{repo}/actions/runs/{id}/attempts/{attempt}/jobs` for each run whose jobs are not collected or whose status is not `completed` (up to 10 pages, 4-way concurrency); `reuseCachedJobs` skips only completed runs with a matching cached attempt and `jobs_complete`. This adds a per-run N+1 family on both collection paths. `activity/run-activity.mjs` also removes cached per-run `agent/` directories locally before invoking `logs.main`. |
| `.github/workflows/optimization-ai-credit-auditor.md` | Target repository, two days, at most 100 runs; locally filtered to the preceding 24 hours | `/tmp` for the current run | Overlaps the dashboard usage window and the evaluator's later evidence window. A separate API call first reads the current run's creation time. |
| `.github/workflows/optimization-ai-credit-optimizer.md` | Target repository, seven days, at most 50 runs | `/tmp` for the current run | Overlaps the auditor and dashboard collections. Monitoring workflows are filtered only after download. |
| `.github/graders/optimization-ai-credit-auditor-operational-value.sh` | Evaluator-defined before/after window, up to 10,000 runs | Evaluator temporary directory | Re-fetches evidence rather than consuming the worker's predownload, which is necessary for maturation but duplicates historical portions of earlier scans. |
| `.github/graders/optimization-ai-credit-optimizer-operational-value.sh` | Seven-day before/after evidence window, up to 10,000 runs | Evaluator temporary directory | Re-fetches overlapping target history for every evaluation or regrade. |
| `.github/graders/optimization-agents-md-curator-operational-value.sh` (formerly `ambient-context-agents-md-curator-operational-value.sh`) | Thirty-day before/after evidence around an applied change, up to 10,000 runs | Evaluator temporary directory | Potentially the largest retained-log window and repeated for regrades. |
| `.github/workflows/agentics-maintenance.yml` | Repository activity report, one week, up to 500 runs | Actions cache under `.cache/gh-aw/activity-report-logs` | This conventional maintenance workflow maintains a separate gh-aw log cache and does not reuse the CAO activity snapshot. |

All bounded production log collectors except monthly budget admission reserve 2,000 GitHub API requests through `--max-github-api-rate-limit -2000`. This is fail-closed protection, not shared coordination: concurrent collectors using the same credential can each begin work and then independently stop at the reserve.

`gh aw forecast` in the auditor and `agentics-maintenance.yml` may read or build gh-aw log caches internally. They are not additional literal `gh aw logs` calls, but they overlap the same run-history domain and must be considered when measuring actual API traffic.

## 3. GitHub API and predownload inventory

### 3.1 Shared control path

| Source | Requests and behavior | Existing mitigation |
| --- | --- | --- |
| `.github/workflows/shared/control.md` | A sparse, shallow `actions/checkout` of `.github/cao/src` at `github.workflow_sha` replaced the earlier pair of Contents API reads for `control.mjs` and `policy.mjs`. Every importing workflow execution still performs one exact-SHA checkout before activation. | Exact-SHA provenance is preserved; the checkout uses `fetch-depth: 1` and cone-mode sparse paths, avoiding the two separate Contents API requests previously issued per run. No shared artifact or cross-run checkout reuse exists in this job. |
| `.github/cao/src/control.mjs` | Reads rate limits, control policy, repository metadata, workflow inventory, repository inventory pages, and safe-output metadata. It does not read target policy or target commits for worker activation. It also checks runner free disk space before repository discovery (no API calls). Admission writes a local `admission.json` record (repository, workflow, run, package, role, checks, and any capacity observations already read) to the job-local `RUNNER_TEMP/cao` directory. | `gh api --cache 60s` for helper reads, a capacity check before precompute, bounded repository pages, and clean rate-limit denial. The cache is job-local and short-lived. The admission record is a local file write of already-collected data, not an additional GitHub API request. |

The former two-request Contents API bootstrap in `shared/control.md` has been replaced by a single git checkout step; this is no longer a Contents API cost per run, though it still runs once per importing workflow execution before the in-process 60-second CLI cache can help. Compiled lock files repeat this shared implementation but do not represent extra calls beyond the workflow executions themselves.

`control.mjs` queries `gh api rate_limit` during each admission and uses the returned core limit, remaining count, and reset time directly. The check does not require a repository variable or a write-scoped token.

### 3.2 Activity and dashboard path

| Source | Requests and behavior | Existing mitigation or gap |
| --- | --- | --- |
| `activity/index.mjs` | Performs no GitHub API operations. It reads checked-out workflow sources and locks, local control-plane inventory, and the shared `gh aw logs` snapshot. | Target repositories are policy subjects rather than workflow-discovery roots. Missing usage-artifact metadata is reported by field and bounded sample run IDs instead of triggering fallback Actions API reads. |
| `activity/github-telemetry.mjs` | Runs `gh api rate_limit` after shared log acquisition and around the remaining GitHub-backed dashboard collectors, appending rate-limit and activity-cache-hydration snapshots to a job-local JSONL ledger (`$RUNNER_TEMP/cao-gh/cao-gh.jsonl`). | The local activity-index transform has no telemetry probe because it performs no GitHub operations. The rolling 24-hour ledger remains in the activity cache and the separate 30-day artifact. |
| `dashboard/report/records.mjs` | For every report repository, fetches up to ten pages each of all issues and issue comments, the first 100 Actions artifacts, and run metadata referenced by outputs. **New:** an explicit `GET /repos/{repo}` scan (4-way concurrency) covers every report/remote repository and gates further collection on complete repository metadata. Each enrolled non-control repository also gets up to 10 workflow-list pages, a default-branch commit lookup, and a `.github/workflows` contents listing; discovered `.lock.yml` files are downloaded from `raw.githubusercontent.com` (8-way concurrency) to extract `gh-aw-metadata`/`gh-aw-manifest`. One `GET /repos/github/gh-aw/releases/latest` call is issued per run whenever remote workflow repositories are enrolled, even if none expose a `.lock.yml`. | Promise memoization deduplicates run metadata only within one process. A prior snapshot is retained on rate limit only when it does not contain private data. Successful runs rescan issue/comment history and artifact metadata. Raw workflow downloads reuse unchanged blob-SHA entries; repository visibility, commit, and contents lookups are uncached. |
| `dashboard/report/operational-values.mjs` | Processes operational-value grader results already present in the shared gh-aw logs JSON. | Persistent observations are merged with new results without a second history scan or per-run artifact download. |
| `dashboard/dispatch-workflow.mjs` | Dispatches activity/dashboard workflows and polls every five seconds until discovery and completion. | The dispatch response can eliminate discovery polling when it contains run details. Completion polling still has no ETag or backoff between requests; a 120-minute run can make about 1,440 status requests. A 403 rate-limit response now short-circuits into a `skipped` output that the calling workflow (`dashboard/dashboard.yml`, `.github/workflows/dashboard-build.yml`) uses to skip the downstream build/pages job, so a rate limit stops the chain instead of failing partway through a build. |
| `dashboard/local-server.mjs` | Reads repository default branch, finds the latest dashboard-data artifact, validates its run, then downloads that artifact before serving. Also issues one additional `gh api user` call at startup to populate a local-only `/viewer.json` (login, name, avatar URL) for the account-menu identity display. | One startup predownload plus one startup identity read, no repeated polling. There is no local reuse between server starts; the viewer identity is re-fetched every time the local server starts. |
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
| `.github/workflows/design-decision-gate.md` | Now `/design-gate` slash-command only (no automatic `pull_request` trigger): one `gh pr view` (json fields), one paginated `gh api .../pulls/{n}/files`, and conditionally one `gh pr diff` (skipped above 300 files) per invocation. | Prefetch is a single bounded step per slash-command invocation with an explicit diff-size cutoff; no cross-run cache or reuse of a prior gate's fetched files/diff for the same pull request, and repeated invocations on the same pull request re-fetch identical metadata. |
| `.github/workflows/mattpocock-skills-reviewer.md` | Now `/matt` slash-command only (the automatic `ready_for_review` trigger was removed): one `gh pr view`, one `gh pr diff` (truncated to 3,000 emitted lines, excluding lock/dist/build paths), and one paginated `gh api .../pulls/{n}/comments` per invocation. | Diff line-cap and path exclusion bound payload size, but repeated slash-command invocations on the same pull request still re-fetch the same metadata, diff, and comments from scratch; removing the automatic trigger eliminates the prior per-push/per-readiness-change re-fetch. |
| `.github/workflows/pr-sous-chef.md` | Every 30 minutes (or on `/souschef`): one `gh pr list` across up to 50 open, non-draft pull requests with rollup status fields; the prompt additionally directs "bounded, paginated reads" for checks/review threads on a shortlisted candidate; each selected candidate now also triggers a full `fetch-depth: 0`/`fetch: ["*"]` checkout of the entire repository history to check out the candidate's head branch for fixing. | The list call is a single bounded request per run, but scheduling every 30 minutes rescans the full open-PR queue each time; there is no persisted watermark of previously nudged or already-evaluated pull requests. The workflow was redesigned from an advisory nudge (posting a comment) to fixing blockers and pushing commits via `push_to_pull_request_branch`, which is a new git-history acquisition path (full unshallow clone) not present in the earlier advisory design. |
| `.github/workflows/self-care-open-source-failures.md` | Restores the same `cao-activity` Actions cache used by the dashboard and reads only its persisted `deployed-workflows.json` snapshot; issues remediation issues via the `issues: read` toolset without additional API calls in the prefetch step. | No new GitHub API collection: this worker is a pure consumer of the existing activity snapshot and fails closed (`incomplete`) when the snapshot is missing, stale, or does not cover a full seven-day run-health window. |
| `.github/workflows/self-care-dashboard-performance.md` | Runs Lighthouse/Playwright audits against the built dashboard site; persists only a local round-robin rotation state file (`/tmp/gh-aw/cache-memory/dashboard-performance-rotation.json`, capped at 30 entries) and uploads a run evidence artifact. | No `gh aw logs` calls and no direct GitHub API/REST/GraphQL requests in prefetch or evaluation; no operational-value grader exists yet for this worker, so it adds no new collection or N+1 acquisition path. |
| `.github/workflows/self-care-glossary.md` (new; SelfCare's tenth worker) | Uses the `pull_requests`, `repos`, and `actions` `gh-proxy` toolsets to find the prior successful `self-care-glossary` run (start time as evidence lower bound, 24-hour default, seven-day cap), then inspects up to 50 merged pull requests (with changed-file lists and diffs) and up to 100 default-branch commits in that window. | Bounded per-run counts (50 PRs, 100 commits) and a cap on catch-up window exist, but there is no persisted watermark artifact beyond the workflow's own run history; each run re-derives its lower bound by querying prior runs rather than reusing a stored cursor. Runs at most once every 24 hours, gated by the orchestrator's own recent-run check below. |
| `.github/workflows/self-care-pages-health.md` (SelfCare's eleventh worker) | Runs a deterministic, no-GitHub-API Playwright collector (`dashboard/site/test/performance/pages-health.mjs`) against the deployed Pages dashboard and evaluates the resulting evidence files. Its `github` toolset (`gh-proxy`, `pull_requests`/`repos`/`actions`) is available to the agent but the prefetch step itself issues no `gh api`, `gh aw logs`, or REST/GraphQL calls; only local browser navigation and Lighthouse runs. | No new GitHub collection path: this worker's cost is entirely local browser/Lighthouse traffic to the already-public Pages site plus, if it opens a pull request, the standard `create_pull_request` safe-output write. The orchestrator's six-hour cadence gate (20 most recent runs) is the only run-history read associated with this worker. |
| `.github/workflows/self-care-experimental-views.md` (new; SelfCare's twelfth worker) | Declares a `pull_requests`/`repos`/`actions` `gh-proxy` toolset, but its prefetch and agent instructions issue no `gh api`/`gh aw logs` calls; substantive evidence comes from local Playwright runs (Chromium and WebKit) against the already-built local dashboard site and DOM-size measurements. | No material GitHub collection beyond the standard `create_pull_request` safe-output write, matching `self-care-accessibility-checker.md`/`self-care-primer-brand-checker.md`; the declared toolset is unused capacity, not an active request path. |
| `.github/workflows/self-care-dashboard-data-schema.md` (new; SelfCare's thirteenth worker) | Only in live mode against the control repository, `pre-agent-steps` fetch the already-deployed Pages `sources/manifest.json` then every advertised `sources/{name}.json` file (bounded to 500 unique, pattern-validated source names) via plain `curl`; the agent then compares an inferred schema document against `specs/dashboard-data.md`. No `gh api`/`gh aw logs`/GitHub REST or GraphQL calls anywhere in prefetch or agent instructions. | No GitHub collection: this is unauthenticated static-site traffic to the same public Pages data already served to dashboard browsers, not a GitHub API request. `self-care.md` additionally gates this worker's dispatch behind a 10-run/24-hour cadence check (see below), duplicating the existing `self-care-glossary` cadence-read pattern rather than adding a new collection family. |
| `.github/workflows/actions.yml` (mobile dashboard integration) | On `push`/`pull_request`/schedule, runs Playwright mobile scenarios against the built dashboard (no GitHub API calls in the collector itself), then a `github-script` step reads a paginated `issues.listComments` (up to 100 per page) for the triggering pull request to find and upsert one prior bot comment before creating or updating it. | Single bounded per-event read-then-write comment upsert; only runs on `pull_request` events, so it adds no scheduled or unbounded scan, but each triggering PR event re-lists all its comments rather than caching the found comment ID across pushes to the same PR. |
| `.github/workflows/dashboard-views.yml` (new) | On `push`/`pull_request`, runs an informational Playwright assessment against the already-built static `sources.json`/`dashboard.json` (`fetch(DASHBOARD_DATA_URL)` and a local preview server fetch, no GitHub API calls in the collector). Its comment job then reads a paginated `issues.listComments` (up to 100 per page) for the triggering pull request to find and upsert one prior bot comment, identical in shape to the `actions.yml` mobile-dashboard upsert. | Same bounded read-then-write comment-upsert pattern as `actions.yml`; each triggering pull request event re-lists all its comments from scratch rather than caching a found comment ID across pushes, duplicating that workflow's independent per-event comment scan. |
| `.github/workflows/self-care-code-improvement.md` and `self-care-dashboard-language-refactor.md` | Each run's `pull_requests`/`repos`/`actions` `gh-proxy` toolset reads the three most recently closed pull requests from the same worker workflow (newest first) as positive/negative reuse signal before selecting a refactor candidate. | Bounded to three PRs per run with no paired grader collection found; each run re-lists closed PRs from scratch rather than caching the previously read set, so repeated dispatch cycles re-fetch overlapping PR history. |
| `.github/workflows/self-care-accessibility-checker.md` and `self-care-primer-brand-checker.md` | Both declare a `repos`/`actions` `gh-proxy` toolset, but neither's prefetch or agent instructions issue any `gh api`/`gh aw logs` calls; all substantive evidence comes from local Playwright/axe-core (accessibility) or the `primer-brand` MCP server (brand checker) against the already-built local dashboard site. | No material GitHub collection beyond the standard `create_issue`/`create_pull_request` safe-output write; the declared toolset is unused capacity, not an active request path. |
| `.github/workflows/self-care-docs-build-time-investigator.md` | The worker's own instructions read only `.github/workflows/docs.yml`, `dashboard-build.yml`, and their Actions runs (`actions: read`) for evidence, capped at the latest 20 completed `docs.yml` runs from the last 14 days; the paired grader (`self-care-docs-build-time-investigator-operational-value.sh`) separately calls `gh api repos/{repo}/actions/workflows/docs.yml/runs` with its own before/after evidence window. | The worker and its grader independently query overlapping `docs.yml` run history without a shared snapshot; the worker persists a `repo-memory`-backed suggestion-rotation ledger to avoid repeating a category, but does not cache the raw run list itself between dispatches. |

| `.github/workflows/self-care.md` (orchestrator) | Before dispatching `self-care-dashboard-data-schema` or `self-care-glossary`, inspects at most the ten most recent workflow runs of each (via the `actions` `gh-proxy` toolset) to enforce a 24-hour dispatch cadence per worker. Before dispatching `self-care-pages-health`, inspects at most the 20 most recent `self-care-pages-health` workflow runs through the same toolset to enforce a six-hour cadence. All three checks fail closed (skip dispatch) when run history is unavailable or ambiguous. Dispatches the ten regular (non-cadence-gated) workers, including `self-care-experimental-views`, on every selected repository run. | Each cadence check is bounded (10 or 20 runs) and only gates one worker's dispatch; these are small, independent run-history reads separate from the shared `cao-activity` snapshot. The glossary worker separately re-derives its own evidence-window lower bound from the most recent successful run, so the same "most recent run" fact can be queried twice per worker per dispatch cycle; `self-care-pages-health` and `self-care-dashboard-data-schema` have no equivalent worker-side prior-run lookup, so their cadence checks are each the only run-history read for that worker. `self-care-experimental-views` adds no new run-history read of its own. |

Administrative setup (`.github/cao/setup-github-apps.mjs`), release workflows, CI checks, and e2e scripts also use GitHub APIs. They are interactive or repository-maintenance traffic rather than operational collection, but they share the caller's quota and should not be scheduled concurrently with large audits when they use the same token.

## 4. Cache and index topology

| Cache or index | Producer | Consumer | Reuse boundary |
| --- | --- | --- | --- |
| `cao-activity-*` Actions cache | `.github/workflows/activity.yml` | Next activity run and dashboard builder | Complete collection snapshot; latest matching key across runs |
| `deployed-workflows.json` local run index | `activity/index.mjs` | Activity collectors | Rebuilt from checked-out metadata and the shared logs snapshot without API fallback |
| Shared gh-aw logs JSON, state, and artifacts | `activity/logs.mjs` | Activity index plus AI Credit, security, and operational-value collectors | Persistent activity cache |
| Operational-value observations | `dashboard/report/operational-values.mjs` | Later activity runs | Retained inside the shared `cao-activity-*` Actions cache |
| `records.mjs` run map | `dashboard/report/records.mjs` | The same process | In-memory only |
| gh-aw release list | `aw-maintenance-upgrade.md` | Later upgrade runs | 24-hour file cache restored by Actions cache |
| Maintenance activity and forecast logs | `agentics-maintenance.yml` | Later maintenance runs | Separate Actions caches, outside the CAO activity snapshot |
| GitHub API telemetry ledger (`cao-gh.jsonl`) | `activity/github-telemetry.mjs` | Next activity run's dashboard quota history and the `cao-gh` artifact | Rolling 24-hour window retained inside the `cao-activity` cache; trimmed on restore by `prepare`, not a fresh discard per run |
| Dashboard source document | Dashboard data worker | Current browser session and later page queries | Canonical generations in IndexedDB; noncanonical source rows retained only in worker memory and reconstructed after reload |
| Dashboard data artifact | Dashboard build | Local server | Predownloaded once per local-server start; no local persistence contract |

The activity snapshot is the shared collection boundary. It persists the bounded gh-aw logs JSON and downloaded artifacts beside derived AIC and operational-value records.

## 5. Duplicate work

1. **Run history is collected by multiple independent systems.** The activity snapshot makes one shared gh-aw logs download, while worker predownloads and graders later collect overlapping target evidence windows. The activity index no longer performs a parallel Actions API scan.
2. **Monthly budget admission rescans package history per execution.** Each budgeted orchestrator run invokes `gh aw logs` once per package workflow even when another run recently computed the same month-to-date total.
3. **Dashboard durable records rescan stable history every 15 minutes.** Issues and comments are fetched from the beginning, rather than incrementally from the previous snapshot's newest update.
4. **Control bootstrap still runs once per workflow run.** The exact-SHA runtime files are now obtained via one sparse, shallow git checkout instead of two Contents API reads, but each importing run still repeats this checkout independently before the helper's CLI cache exists.
5. **Control-repository workflow metadata is local.** The activity index reads the checked-out sources and locks once; it no longer rediscovers registries, trees, manifests, or source content through the API.
6. **Per-candidate grader requests create N+1 traffic.** Dependabot and AW Optimization (formerly ambient-context) evaluators enumerate broad candidate lists and then query files, checks, statuses, or comments one candidate at a time.
7. **Separate maintenance caches overlap the activity cache.** `agentics-maintenance.yml` stores independent activity/forecast log trees that cannot satisfy CAO dashboard or grader collection.
8. **Telemetry probes now persist across runs.** `github-telemetry.mjs` issues a fresh `gh api rate_limit` call before and after each activity phase, independent of the capacity check already performed by `control.mjs` admission/precompute. Its ledger is retained for a rolling 24-hour window through the `cao-activity` cache (rather than deleted each run), so historical rate-limit/cache-hydration entries now survive across scheduled runs for dashboard trend rendering, but the per-run probe count itself is unchanged.
9. **New per-event PR automation prefetch is not shared across workflows.** `design-decision-gate.md` and `mattpocock-skills-reviewer.md` are now both slash-command-only (`/design-gate`, `/matt`) rather than triggered automatically on `pull_request` events; each independently fetches `gh pr view`, a diff, and paginated files or review comments for the same pull request when separately invoked, and neither consumes the other's prefetched evidence, so repeated slash-command re-invocation of either workflow re-fetches identical metadata each time.
10. **`pr-sous-chef.md` polls the full open-PR queue on a fixed schedule.** Every 30 minutes it re-lists up to 50 open, non-draft pull requests with status-rollup fields regardless of whether anything changed since the previous run, and it has no persisted watermark to skip already-evaluated candidates. It was also redesigned from a comment-only advisory nudge to a code-fixing worker that checks out each selected candidate's branch with a full (`fetch-depth: 0`, `fetch: ["*"]`) clone and pushes commits via `push_to_pull_request_branch`, adding a new full-history git acquisition cost per selected candidate that did not exist in the prior advisory design.
11. **`self-care-dashboard-review.md` maintains its own artifact/run discovery path.** Its live-mode prefetch independently calls the artifacts and runs APIs and downloads the dashboard artifact, duplicating metadata already collected by `activity/index.mjs` and `records.mjs`; it does not reuse the `cao-activity` snapshot, so every dispatched review re-discovers the same current artifact and recent run history from scratch.
12. **The `self-care-glossary` and `self-care-dashboard-data-schema` workers and the orchestrator cadence check independently query the same run history shape.** `self-care.md` inspects up to 10 recent runs of each workflow to enforce its own 24-hour dispatch gate, and `self-care-glossary` additionally re-derives its own evidence-window lower bound from the most recent successful run; neither worker reuses the other's or the orchestrator's already-fetched run metadata, and the glossary worker further fetches up to 50 merged-PR diffs/file lists and up to 100 commits per run with no persisted cursor beyond run history itself. `self-care-dashboard-data-schema` has no worker-side prior-run lookup of its own (it issues no GitHub API calls at all), so only the orchestrator's cadence check reads run history for it. `self-care-pages-health` adds a third, independent cadence check (up to 20 recent runs, six-hour gate) with no worker-side prior-run lookup either.
13. **`activity/logs.mjs`'s new Actions API fallback re-fetches per-workflow run history that `gh aw logs` already attempted.** When the single bounded `gh aw logs` invocation fails, `enrichFromActions`/`runGhApi` issues one `GET .../actions/workflows/{workflow}/runs` request per compiled `.lock.yml` workflow (4-way concurrency) to rebuild the same 30-day run snapshot the failed call was trying to obtain, rather than retrying the single `gh aw logs` call or reusing a partial result from it.
14. **`records.mjs` now scans remote workflow listings for every enrolled repository on every run.** The new cross-repository workflow discovery (`repositoryWorkflowSource`) re-lists all Actions workflows for each enrolled repository other than the control repository on every dashboard collection, independent of and in addition to the existing per-repository issue/comment/artifact scan in the same function.
15. **`self-care-docs-build-time-investigator.md` and its grader independently rescan the same `docs.yml` run history.** The worker's own instructions fetch up to the latest 20 completed runs (14-day window) for evidence; its paired operational-value grader separately calls the Actions run-list API with its own before/after window over the same workflow, so a producer run and its later regrade issue at least two independent `docs.yml` run-list requests instead of one shared snapshot.
16. **`self-care-code-improvement.md` and `self-care-dashboard-language-refactor.md` re-fetch the same worker's PR history each dispatch.** Each worker reads the three most recently closed pull requests from its own workflow as reuse/rejection evidence; there is no persisted cursor, so every run re-lists this small but overlapping PR set from scratch.
17. **`dashboard-views.yml` duplicates `actions.yml`'s per-PR comment-upsert pattern.** Both workflows independently paginate `issues.listComments` (up to 100 per page) on the same triggering pull request to locate their own bot comment before upserting it; neither shares a found comment ID with the other, so a single pull request event can trigger two independent full comment-list scans for two different marker comments.
18. **`activity/logs.mjs` adds a per-run job-metadata N+1 family.** `collectJobDetails` requests the Jobs API for runs without collected jobs or with a non-`completed` status on both collection paths; only completed runs with a matching cached attempt and `jobs_complete` are reused.
19. **`records.mjs` adds uncached repository-state follow-ups.** Every enrolled repository gets visibility metadata, and each enrolled non-control repository gets a default-branch commit lookup and workflow-directory listing; changed remote locks trigger raw downloads, while unchanged blob-SHA entries reuse cached metadata. The latest-release lookup runs whenever remote workflow repositories are enrolled, regardless of whether a lock is found.
20. **`activity/logs.mjs` now downloads the `agent` artifact family it previously excluded.** The bounded `gh aw logs` invocation's `--artifacts` list gained `agent`, so heavy per-run agent transcripts are pulled into the shared `cao-activity` cache alongside the existing usage/detection/evals/experiment/firewall/github-api/graders/mcp sets, increasing per-run artifact-download size without a new GitHub API request family. `dashboard/report/aic-usage.mjs`'s new `readRunTimeline` reads several of these already-downloaded files (`gateway.jsonl`, `rpc-messages.jsonl`, firewall `audit.jsonl`, `copilot-session-state/*/events.jsonl`) to populate a new canonical session/event data model; this is additional local processing of the same predownloaded artifacts, not additional GitHub collection.

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
| P2 | Per-phase telemetry rate-limit probes | Up to 8 additional `gh api rate_limit` reads per activity run beyond the admission/precompute capacity check; low absolute cost against the separate `rate_limit` allowance, but still avoidable duplication. The ledger is now retained 24h via the activity cache, so the historical dashboard view no longer needs a fresh full-window probe count each run, but the per-run request volume is unchanged. |
| P2 | Duplicate per-PR review prefetch | `design-decision-gate.md` and `mattpocock-skills-reviewer.md` are now slash-command-only, removing their prior automatic re-fetch on every qualifying push/readiness change; each still independently re-fetches the same pull request's metadata, diff, and paginated files/comments whenever separately invoked, and slash-command reuse still re-fetches identical evidence per invocation. |
| P2 | Fixed-schedule PR queue polling | `pr-sous-chef.md` re-lists up to 50 open pull requests every 30 minutes regardless of change, with no persisted watermark; each fixed candidate now also incurs a full unshallow git checkout. |
| P2 | Duplicate glossary/dashboard-data-schema run-history lookups | `self-care.md`'s cadence gates for `self-care-glossary` and `self-care-dashboard-data-schema` (10 runs each) and `self-care-glossary.md`'s own evidence-window bootstrap independently query recent run history within the same dispatch cycle; low absolute cost but avoidable duplication. `self-care-pages-health.md`'s six-hour cadence gate (up to 20 runs) is a further, similarly bounded but non-overlapping run-history read; neither `self-care-pages-health` nor `self-care-dashboard-data-schema` has a worker-side counterpart to duplicate. |
| P1 | New per-workflow Actions API fallback in `activity/logs.mjs` | On any `gh aw logs` failure, one Actions run-list request is issued per compiled `.lock.yml` workflow (4-way concurrency, up to 100 runs each); this scales with workflow count and converts one failed bounded call into many separate list requests in the same run. |
| P2 | New per-repository remote workflow discovery in `records.mjs` | Every enrolled repository other than the control repository is scanned (up to 10 pages of the Workflows API) on every dashboard collection to power cross-repository marketplace views; bounded per repository but adds a request family that scales with enrolled-repository count and runs alongside the existing issue/comment scan. |
| P2 | Duplicate `docs.yml` run-history reads | `self-care-docs-build-time-investigator.md` and its operational-value grader each independently query up to 20 (worker) or grader-window-bounded runs of `docs.yml`; low absolute cost but avoidable duplication between producer and evaluator. |
| P2 | Duplicate per-PR comment upsert scans | `actions.yml` and `dashboard-views.yml` each independently paginate the full comment list of the same triggering pull request to find their own marker comment; low per-event cost but two full scans occur on every pull request event instead of one shared lookup. |
| P1 | New per-run job-metadata collection in `activity/logs.mjs` | Runs lacking collected jobs or not yet completed incur paginated Jobs-API requests (up to 10 pages, 4-way concurrency); only completed matching attempts with `jobs_complete` are reused. |
| P2 | New per-repository visibility/commit/contents scan in `records.mjs` | Report/remote repositories receive uncached visibility metadata; remote repositories also receive uncached commit and contents lookups. Raw lock downloads alone are blob-SHA cached. |

The direct activity client retries 403 and 429 responses only when the advertised delay is at most 30 seconds. `records.mjs` instead stops on a confirmed rate limit and retains the prior snapshot. Dispatch polling and most GitHub Script or shell clients have no common rate-limit response policy.

## 7. Recommendations

1. **Replace fixed completion polling with bounded backoff.** Start at the current responsive interval, increase it for long-running jobs, honor `Retry-After` and rate-limit reset headers, and prefer returned run details to discovery polling. **(Partially addressed:** `dispatch-workflow.mjs` now detects a 403 rate-limit response and emits a `skipped` output so `dashboard/dashboard.yml` and `dashboard-build.yml` skip the downstream build/pages job; the fixed five-second interval and lack of proactive backoff on successful polling remain.)
2. **Make the activity snapshot the reusable run-data boundary.** Persist a bounded raw gh-aw log cache beside derived AIC data, with repository, time-window, completeness, and credential-scope metadata. Permit consumers to reuse it only when those bounds satisfy their request.
3. **Increment durable-record collection.** Retain per-repository update watermarks, request only changed issues/comments, and periodically perform a bounded reconciliation scan. Preserve the prior snapshot when completeness cannot be proven.
4. **Cache month-to-date package usage.** Key it by package workflow set, repository, month, and latest observed run ID; invalidate it when the activity index observes a newer relevant run.
5. **Reduce activity discovery calls.** Persist ETags or immutable blob SHAs for registry, tree, manifest, Markdown, and lock data. Avoid repository metadata rereads within one process and prefer allowlist discovery over organization code search where policy already supplies the scope.
6. **Batch or narrow grader evidence.** Record immutable evidence identifiers during the producer run, query candidates by time where supported, and reuse one evaluation-local repository snapshot across graders. Keep existing fail-closed completeness rules.
7. **~~Bundle exact-SHA control runtime files.~~ (Implemented)** Control bootstrap now uses one sparse, shallow checkout instead of two Contents API calls, preserving the exact-SHA workflow provenance boundary. Remaining opportunity: avoid repeating this checkout across concurrently running importing workflows when feasible.
8. **Instrument request budgets.** Emit request counts by endpoint family, cache hit/miss, pages read, downloaded bytes, remaining core/search quota, and incomplete reason. Use this evidence before changing concurrency or reserve thresholds.
9. **Do not merge caches solely by repository.** Cache keys must retain token/installation scope, private-data policy, exact source SHA where relevant, requested time window, and completeness. A cache hit must never widen repository authority or publish private data.
10. **Fold telemetry probes into existing capacity checks.** `github-telemetry.mjs`'s per-phase `gh api rate_limit` calls duplicate the admission/precompute capacity read; record the already-obtained rate-limit response instead of re-querying it, or reduce probe frequency to once per run. **(Partially addressed:** the ledger is now retained 24h across runs via the activity cache instead of being deleted each run, which fixed the dashboard's quota-history rendering gap, but the per-run probe count is unchanged.)

## API Request Relationships

```mermaid
flowchart LR
  subgraph Control
    control["control.mjs admission<br/>rate_limit, policy, inventory"]
    budget["applyMonthlyBudget<br/>gh aw logs, up to 1000 runs/workflow"]
  end
  subgraph Activity
    logsmjs["activity/logs.mjs<br/>gh aw logs, 30-day window,<br/>now incl. agent artifacts"]
    fallback["enrichFromActions<br/>runs API per workflow, 4-way concurrency"]
    jobsapi["collectJobDetails<br/>Jobs API per run, 4-way concurrency"]
    indexmjs["activity/index.mjs<br/>local only"]
    telemetry["github-telemetry.mjs<br/>rate_limit probes"]
    cache[("cao-activity Actions cache")]
  end
  subgraph Dashboard
    records["records.mjs<br/>issues/comments/artifacts, per repo"]
    repostate["repositoryStates<br/>GET /repos/{repo} per repo, 4-way concurrency"]
    remotewf["repositoryWorkflowSource<br/>Workflows API + raw .lock.yml download per repo"]
    dispatch["dispatch-workflow.mjs<br/>5s completion polling"]
  end
  subgraph Workers
    aicaud["ai-credit-auditor<br/>gh aw logs, 2 days"]
    aicopt["ai-credit-optimizer<br/>gh aw logs, 7 days"]
    reviewpf["self-care-dashboard-review<br/>artifact+run discovery"]
    glossary["self-care-glossary<br/>PR diffs + commits"]
    docsbt["self-care-docs-build-time-investigator<br/>docs.yml runs, 14-day window"]
    expviews["self-care-experimental-views<br/>local Playwright only, no API"]
    schemaworker["self-care-dashboard-data-schema<br/>curl Pages data, no API"]
    selfcare["self-care.md<br/>cadence gates: glossary, pages-health, dashboard-data-schema"]
    graders["operational-value graders<br/>re-fetch evidence windows"]
  end
  subgraph PRAutomation
    ddg["design-decision-gate.md<br/>pr view/diff/files"]
    mattpocock["mattpocock-skills-reviewer.md<br/>pr view/diff/comments"]
    soschef["pr-sous-chef.md<br/>pr list, full clone"]
    mobileci["actions.yml<br/>listComments upsert"]
    dashviews["dashboard-views.yml<br/>listComments upsert"]
  end
  control -->|capacity check| budget
  logsmjs -->|snapshot write| cache
  logsmjs -.->|on failure| fallback
  fallback -.->|merges onto| cache
  logsmjs -->|per-run jobs| jobsapi
  fallback -->|per-run jobs| jobsapi
  jobsapi -.->|reuses cached jobs from| cache
  cache -->|reused by| indexmjs
  cache -->|reused by| records
  telemetry -->|appends to| cache
  records --> repostate
  repostate -->|gates| remotewf
  dispatch -->|polls| records
  aicaud -.->|overlaps window| cache
  aicopt -.->|overlaps window| cache
  reviewpf -.->|does not reuse| cache
  glossary -->|own run-history lookup| selfcare
  schemaworker -.->|cadence gated by| selfcare
  docsbt -.->|independent window vs| graders
  graders -.->|re-fetches evidence, ignores| cache
  ddg -.->|independent of| mattpocock
  mobileci -.->|duplicate comment scan| dashviews
```

The diagram highlights the shared `cao-activity` cache as the intended reuse boundary and shows which paths (Actions API fallback, remote workflow discovery, per-worker predownloads, and graders) bypass it and independently re-collect overlapping history.

## 8. Suggested implementation order

1. Back off dashboard dispatch polling and add request-count telemetry.
2. Increment `records.mjs` issue/comment collection.
3. ~~Persist and reuse bounded gh-aw logs through the activity cache.~~ **(Implemented)** The activity workflow updates one control-repository logs JSON/artifact snapshot immediately after cache restore and derives the index, AIC, security, and operational-value records from it.
4. Cache month-to-date budget totals against observed run IDs.
5. Narrow grader N+1 evidence lookups.
6. Optimize control bootstrap only after preserving exact-SHA and fail-closed behavior in tests. **(Done: bootstrap now uses a sparse git checkout instead of Contents API reads.)**

These changes should be delivered separately. This audit records current behavior and does not itself change collection, authority, credentials, or cache semantics.
