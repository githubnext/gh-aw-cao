# CAO Activity

The activity package maintains the shared, bounded snapshot used by the Central Agentic Ops dashboard. It indexes deployed GitHub Agentic Workflows and recent runs, collects AI Credit and operational-value observations, and normalizes durable records. It is deterministic GitHub Actions infrastructure: it has no agent, rollout mode, safe output, or target-writing authority.

The root Central Agentic Ops package installs the activity and maintenance action workflows and the indexer. A focused installation is also available from `githubnext/gh-aw-cao/activity@<catalog-release>`.

## Local debugging

Activity entrypoints export `main(actions, args)` and receive the same `core`, `github`, `context`, `exec`, `io`, and `getOctokit` singleton used by `actions/github-script`. To debug an entrypoint locally, copy `activity/.env.example`, adjust its non-secret inputs and paths, then run:

```console
npm run activity:local -- activity/.env
```

The local-action wrapper uses `@github/local-action` to provide Actions Toolkit shims. The local runner can also be invoked directly with the installed toolkit packages:

```console
npm run activity:local:node -- activity/index.mjs
```

To run the complete **Run activity workflow** step locally and write the refreshed cache to `_activity/`, authenticate `gh` and set the control repository:

```console
GITHUB_REPOSITORY=githubnext/gh-aw-cao npm run activity:run-workflow:local
```

The command uses `GITHUB_TOKEN` when set, otherwise it reuses `GH_TOKEN`. A token is required for GitHub-backed collection.

The `CAO Activity` workflow runs `run-activity.mjs` as a single `actions/github-script` step. It sequentially imports and invokes the log downloader, GitHub API telemetry recorder, control policy resolver, control-plane inventory extractor, activity indexer, and dashboard collectors, sharing the same Actions singleton across every call.

## Cache contract

The action restores and saves this directory:

```text
$RUNNER_TEMP/cao-activity/
├── aic-usage.json
├── control-plane-inventory.json
├── control-settings.json
├── dashboard-records.json
├── deployed-workflows.json
├── gh-aw-logs/
├── gh-aw-logs.json
├── gh-aw-logs-state.json
└── operational-values.json
```

Snapshots use the immutable key `cao-activity-${github.run_id}-${github.run_attempt}` and the restore prefix `cao-activity-`. Dispatching consumers wait for the exact activity run and reconstruct its immutable key from the returned run ID and attempt. Cache scope and eviction follow [GitHub Actions cache restrictions](https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows#restrictions-for-accessing-a-cache). The cache is an optimization, not durable historical authority.

GitHub-backed collection operations record quota observations in `cao-gh.jsonl`; the `gh aw logs` call also downloads gh-aw's GitHub API telemetry artifact. Ledger entries contain a stable operation ID, a non-secret credential alias or role and class (`app`, `builtin`, or `unknown`), current `gh api rate_limit` resources before and after log collection, operation outcome, and aggregate activity-cache hydration metadata. Cache file names and per-file metadata are never collected. Credential values are never recorded. The reported core limit is the primary REST API bucket; it does not describe secondary throttling or a downloader context deadline. Reporting keeps quota observations separate from collector/cache health and uploads this ledger as the 30-day `cao-gh` artifact.

Consumers should restore the prefix before downloading workflow-run history or collecting dashboard data. If the cache is absent, stale for the consumer's evidence window, incomplete, or outside the required repository scope, they must fetch the missing evidence. The scheduled and manually dispatchable `.github/workflows/activity.yml` workflow is the only cache publisher. When dashboard report resources are not installed, a focused activity installation publishes only `deployed-workflows.json`.

Immediately after restoring the cache, the activity refresh removes any `agent` directories left in cached log run folders, then runs `gh aw logs --json --audit --cached-json <snapshot>` once for the compiled workflows checked out in the control repository. gh-aw reads and refreshes that same cached JSON snapshot, avoiding repeated downloads for runs already collected. It requests usage, detection, evaluation, experiment, firewall, GitHub API telemetry, grader, MCP, and agent artifacts; the agent evidence is required for access-control and timeline analysis. The downloader also retrieves bounded Actions job metadata for uncached runs so performance views can bind job timing and runner dimensions. It retains the raw JSON, collection state, downloaded artifacts, and per-run `audit.json` payloads under `gh-aw-logs*`. The indexer is then a local-only transformer: it combines checked-out workflow metadata with that snapshot and performs no direct GitHub API operations. AI Credit, security, agent-smell, and operational-value collectors consume the same snapshot without starting additional gh-aw history scans or audits.

Run the `CAO Maintenance` workflow with the `clear-cache` command to delete CAO-managed cache entries, including entries that use legacy CAO cache keys.

## Activity index schema

`deployed-workflows.json` is a UTF-8 JSON object with `schemaVersion: 1`.

| Field | Shape | Meaning |
| --- | --- | --- |
| `generatedAt` | ISO 8601 string | Time the index was refreshed. |
| `organization` | string | Indexed organization login. |
| `repositoryScope` | `allowlist` | The checked-out control repository is the workflow discovery boundary. |
| `allowedRepositories` | string array | The control repository whose checked-out workflows were indexed. Target repositories remain policy subjects, not workflow-discovery roots. |
| `includePrivate` | boolean | Whether private repositories were eligible for discovery. |
| `repositoryCount` | integer | Repositories considered by the indexer. |
| `organizationRepositories` | object | Reserved organization counts; values are `null` because the local index does not query repository inventory. |
| `discovery` | object | Availability and completeness flags for workflow, manifest, and capability discovery. |
| `runHealth` | object | Run-data availability, completeness, the full-snapshot mode, refresh start, UTC window start, window hours, usage-artifact gaps, and fallback state. |
| `bundles` | array | Discovered package manifests and their registered workflows. |
| `standaloneWorkflows` | array | Workflows not attributed to a discovered package. |
| `workflows` | array | Normalized deployed workflow records. |

Each `workflows[]` record identifies its `repository`, source `path`, workflow `id`, `name`, `state`, role, workers, compiler metadata, and update state. Its `runHealth` contains conclusion counters, `runIds`, and `runRecords`. Each run record contains:

```json
{
  "repository": "owner/repository",
  "runId": 123,
  "runNumber": 12,
  "runAttempt": 1,
  "event": "workflow_dispatch",
  "conclusion": "success",
  "status": "completed",
  "createdAt": "2026-09-03T00:00:00Z",
  "startedAt": "2026-09-03T00:00:01Z",
  "updatedAt": "2026-09-03T00:01:00Z",
  "displayTitle": "Package · target · review"
}
```

Run metadata and any available failure evidence normally come from the `gh aw logs` usage payload. `runHealth.usageArtifact` reports required fields omitted by those artifacts, with aggregate counts and bounded sample run IDs so gaps can be addressed in gh-aw. The downloader binds Actions job timing and runner metadata to each run, reusing completed-run data from the cache and refreshing active runs. If `gh aw logs` fails, it also queries the control repository's Actions workflow-run API and enriches the cached snapshot with basic run identity, status, conclusion, and timing fields. Existing artifact-derived fields remain authoritative. It does not query job logs or artifacts, and admission evidence remains unavailable until gh-aw exposes it. Consumers must use the top-level completeness fields instead of inferring completeness from array length.

If `gh aw logs` fails, the downloader preserves a compatible cached snapshot, attempts bounded Actions enrichment, and records both outcomes in `gh-aw-logs-state.json`. Enriched run health is available but incomplete because artifact-only fields may still be absent. On a cold-cache failure where Actions enrichment also fails, it writes an empty snapshot and marks run health unavailable.
