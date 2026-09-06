# CAO Activity

The activity package maintains the shared, bounded snapshot used by the Central Agentic Ops dashboard. It indexes deployed GitHub Agentic Workflows and recent runs, collects AI Credit and operational-value observations, and normalizes durable records. It is deterministic GitHub Actions infrastructure: it has no agent, rollout mode, safe output, or target-writing authority.

The root Central Agentic Ops package installs the activity and maintenance action workflows and the indexer. A focused installation is also available from `githubnext/gh-aw-cao/activity@<catalog-release>`.

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
└── operational-values.json
```

Snapshots use the immutable key `cao-activity-${github.run_id}-${github.run_attempt}` and the restore prefix `cao-activity-`. Dispatching consumers wait for the exact activity run and reconstruct its immutable key from the returned run ID and attempt. Cache scope and eviction follow [GitHub Actions cache restrictions](https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows#restrictions-for-accessing-a-cache). The cache is an optimization, not durable historical authority.

Each GitHub-backed collection operation records a before/after entry in `cao-gh.jsonl` and logs the remaining core quota. Entries contain a stable operation pair ID, a non-secret credential alias or role and class (`app`, `builtin`, or `unknown`), current `gh api rate_limit` resources, operation outcome, and aggregate activity-cache hydration metadata. Cache file names and per-file metadata are never collected. Credential values are never recorded. Reporting keeps quota observations separate from collector/cache health and uploads this ledger as the 30-day `cao-gh` artifact.

Consumers should restore the prefix before downloading workflow-run history or collecting dashboard data. If the cache is absent, stale for the consumer's evidence window, incomplete, or outside the required repository scope, they must fetch the missing evidence. The scheduled and manually dispatchable `.github/workflows/activity.yml` workflow is the only cache publisher. When dashboard report resources are not installed, a focused activity installation publishes only `deployed-workflows.json`.

The activity refresh makes one bounded multi-workflow `gh aw logs --json` call. It retains the raw JSON and requested artifacts under `gh-aw-logs*`; AI Credit, security, and operational-value collectors derive their records from that shared snapshot without starting additional gh-aw history scans.

Run the `CAO Maintenance` workflow with the `clear-cache` command to delete CAO-managed cache entries, including entries that use legacy CAO cache keys.

## Activity index schema

`deployed-workflows.json` is a UTF-8 JSON object with `schemaVersion: 1`.

| Field | Shape | Meaning |
| --- | --- | --- |
| `generatedAt` | ISO 8601 string | Time the index was refreshed. |
| `organization` | string | Indexed organization login. |
| `repositoryScope` | `organization` or `allowlist` | Discovery boundary used for this entry. |
| `allowedRepositories` | string array | Effective repository allowlist; empty for organization discovery. |
| `includePrivate` | boolean | Whether private repositories were eligible for discovery. |
| `repositoryCount` | integer | Repositories considered by the indexer. |
| `organizationRepositories` | object | Public, private, internal, and total repository counts when available. |
| `discovery` | object | Availability and completeness flags for workflow, manifest, and capability discovery. |
| `runHealth` | object | Run-data availability, completeness, full or incremental refresh mode, refresh start, UTC window start, window hours, and fetched page count. |
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

The latest failed run and up to five newest unresolved failed `workflow_dispatch` runs per workflow are enriched from the GitHub Actions jobs API. Enriched records may include `failureJob` and `failureStep`. A generic CAO precompute failure is drilled into once through its job log; only a controlled `[CAO failure]` marker or an allowlisted legacy signature may populate `failureMessage`, and arbitrary log text is never retained. Capacity-related failures also include `admissionStatus`, `admissionReason`, `resource`, `resourceResetAt`, and `resourceWaitHours`. Consumers must use the top-level completeness fields instead of inferring completeness from array length.

When a compatible complete cache entry exists, the indexer retains in-window records and overlaps the previous refresh by one hour. Repositories with newly discovered workflows or retained non-terminal runs receive a full-window refresh. A missing, malformed, incompatible, or incomplete entry causes a complete bounded refresh.
