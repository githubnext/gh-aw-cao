---
name: optimize-query-fleet
description: "Rank CAO dashboard queries with the complexity estimator and optimize the highest-cost query graphs in a coordinated fleet, preserving production outputs and proving computational improvements."
argument-hint: "[--count N] [--input FILE] [--database FILE] [--weighted]"
---

# Optimize Query Fleet

Repeat an estimator-driven dashboard optimization as bounded, independently owned workstreams. Optimize actual production work, not the estimator or the evidence contract.

## Inputs and boundaries

- Default to the top **10** queries in `dashboard/site/dashboard.json`. `--count` must be a positive integer; select fewer only if the document contains fewer queries.
- `--input` selects another dashboard document. Resolve its fragments with the production dashboard bundler, not a direct read of the root JSON.
- `--database` selects profiling evidence; default to `.cao/gh-aw-logs.sqlite`. Download the published evidence when needed with `node activity/cao.mjs download`.
- Ranking is **normalized and unweighted** unless the user supplies `--weighted`. Weighted ranking requires a readable snapshot and passes `--database` to the estimator. These modes can choose very different queries; record the mode and never silently change it.
- Keep the original selected query names fixed throughout the operation. A new top ten after optimization is a diagnostic, not replacement work.
- This skill authorizes local optimization and fleet coordination, not rollout changes, repository discovery by operational workers, PR merging, or unrelated fixes.

Read [CODEBASE.yml](../../../CODEBASE.yml), the affected documents, [Dashboard Language](../../../docs/dashboard-language-specification.md), and [dashboard data](../../../specs/dashboard-data.md). Invoke `reactive-ui` for dashboard changes and `orchestrate` for app-native fleet sessions. Use `npm` only when missing dependencies or installation/network failures require it.

## 1. Freeze selection and baseline

Inspect the worktree without reverting user changes. Record HEAD, the input document, ranking mode, requested count, selected names, and evidence identity. Keep reports, bundled baseline documents, logs, traces, and screenshots in the session artifact directory, not tracked planning files.

Run the existing estimator from the repository root:

```sh
node activity/cao.mjs dashboard-complexity \
  --input dashboard/site/dashboard.json --format json --limit 10
```

Substitute the requested input/count; add `--database FILE` only for weighted ranking. Save the complete JSON output and select `ranking.slice(0, count)`. Do not sort it again by total reads: the estimator's computation-pressure ranking includes materialization pressure and dependency reuse. JSON may contain the entire inventory despite `--limit`.

For every selected query retain its original rank, transitive/direct/dependency read units, materialized field units, consumers, and dependency graph. Save a fully bundled original document with `loadDashboardSource` from `dashboard/report/bundle-dashboards.mjs`.

Before changes, run the focused contracts and relevant broader checks needed to distinguish baseline failures from introduced failures. Do not spend the fleet on unrelated failing tests.

## 2. Establish measurable evidence

Use `tests/helpers/dashboard-query-cost.mjs` and the production query boundary. The existing deployed benchmark is:

```sh
npm run test:performance:dashboard-query-cost
```

It selects the current top candidates and measures each leaf over already materialized dependencies. That is not a full-graph before/after comparison.

Prepare a session-local comparison harness using these existing APIs:

| Stage | Production/helper API |
| --- | --- |
| Open a disposable snapshot copy | `openDeployedDatabase` in `tests/helpers/dashboard-query-cost.mjs` |
| Supply published inventory | `ingestDashboardSources` in `dashboard/site/src/data/ingest/coordinator.js` |
| Resolve required inputs | `resolveDashboardQuerySources` in `dashboard/site/src/data/queries/declarative.js` |
| Load canonical sources | `queryDatabaseSources` and `queryIndexedDatabaseSources` in `dashboard/site/src/data/queries/database.js` |
| Execute and count the entire graph | `executeDashboardQueries` with one `createDashboardQueryBudget` per execution |

Never open the downloaded snapshot in place: the IndexedDB shim can destructively upgrade an older schema. Assert schema compatibility or successful reconstruction, real input records, and usable selected results.

The SQLite snapshot can contain runs but **zero campaigns**, even when the published `inventory-sources.json` contains campaigns and workflow roles. Ingest that real inventory into the disposable copy through the production API before measuring campaign queries. Keep the snapshot, inventory, retention, query context, horizon, and parameters identical for both definitions.

Each selected query needs populated evidence, from the deployed inputs or representative fixtures ingested into canonical storage. Empty/unavailable outputs are state tests, not proof of a speedup. Do not inject fabricated derived sources to make the graph run.

Measure both standalone queries and one batch requesting the entire fixed selection. Consume the lazy results before reading `budget.operations`. Shared dependencies run once per batch; adding private alternatives can improve standalone requests while regressing shared execution.

## 3. Partition and launch the fleet

Group selected queries by overlapping dependency graphs and editable files. Ten query names do not imply ten agents: one continuous shared chain belongs to one workstream. Assign fewer sessions with exclusive source/test ownership; explicitly reserve shared engine, database, estimator, policy, and fixtures. Generated artifacts belong to the coordinator's integration, with branch-local regeneration allowed for separately published workstreams.

Use the [workstream prompt](references/workstream-prompt.md), filling in the actual query names, baseline numbers, revision, ownership, exclusions, and completion gates. Announce the workstreams before launching. Check existing sessions to avoid duplicate work.

Prefer isolated coordinated child sessions with a complete autopilot kickoff and completion notification. Verify each starts at the benchmarked revision. Omit `base_branch` when the project default matches that revision; when the work depends on unmerged parent changes, explicitly use that parent branch. Never combine unrelated baselines without reconciling them.

Give every session a unique regression-test filename. Shared upstream opportunities go to the owning session; they are not permission for multiple sessions to edit the same fragment.

Do independent baseline measurement while sessions run. Use notifications and targeted messages, not sleep/watch/status-poll loops. Treat an idle notification as a turn ending, not as evidence of a verified commit.

## 4. Optimize without weakening contracts

Keep all production selection, joins, aggregates, filters, computations, ordering, and pagination declarative and worker-executed. Do not add presenter callbacks, main-thread filtering, JavaScript source synthesis, or compatibility paths.

Prefer compact intermediates, aggregation before presentation enrichment, removing unused computations/joins, and deferring sorts until after equivalent eligibility filtering. Reuse existing helpers and keep public source contracts stable. Give new helper queries their own `subject`, `objective`, and `acceptance`; they also appear in the generated agent catalog.

Preserve identities, run-attempt versus run counts, null/zero behavior, disabled/active workflows, status priority, target/runtime partitions, links, horizons, filters, route arguments, ordering, and fail-closed duplicate-key behavior. Union-before-join semantics are not interchangeable with joining branches separately.

Metadata is part of the output. An apparently unused event join may carry the oldest timestamp or weakest freshness/completeness. Do not remove that evidence dependency merely because the selected rows expose only counts or AIC. A compact equivalent aggregate may preserve it without enriching every run.

Do not change acceptance requirements, estimator weights, measurement budgets, source retention, or data eligibility to manufacture an improvement. Do not add arbitrary limits.

## 5. Integrate and refresh every query surface

Require each workstream's verified commit SHA, exact paths, per-query estimates, populated operation measurements, validation results, and blockers. Integrate the source commits into the coordinator branch and resolve any shared-source conflict there.

Regenerate the integrated query catalog:

```sh
npm run generate:agent-catalog
node --test tests/unit/cao-agent-catalog.test.mjs \
  tests/unit/cao-mcp-server.test.mjs tests/unit/dashboard-agent-tools.test.mjs
go -C server test ./internal/query/... ./internal/server/...
```

Both `dashboard/site/src/agent/catalog.generated.json` and `queries.generated.json` must match the final bundled definitions. Stale artifacts break CLI/MCP/Go parity even when browser query tests pass. Each separately published workstream must also regenerate its own artifacts.

Do not concatenate or cherry-pick incompatible generated snapshots from several children. Regenerate after the complete integration, and after merging a newer main, then verify generation is reproducible and commit the results.

Create/push PRs only when requested or required by the agreed delivery scope. Track existing workstream PRs to avoid duplicate landing; later user-directed PR maintenance does not automatically authorize restacking the aggregate. Never merge or enable auto-merge.

## 6. Verify the fixed selection end to end

Execute original and optimized bundled definitions through the same canonical boundary and compare raw result objects in memory. JSON round-tripping drops `undefined` properties and can create false differences; serialized reports are evidence, not the equality oracle.

Assert exact row shape and order plus public metadata: availability, completeness, freshness, oldest timestamps, and machine-readable failure semantics. Cover empty, missing, partial, stale, unavailable, duplicate-key, scoped-horizon/filter/search, and route cases through canonical ingestion and the production worker boundary.

Require every selected query to show a computational or materialization improvement without a contract regression. Require the combined selected batch not to regress row operations; report any per-query tradeoff rather than hiding it in an average.

Rerun the estimator against the fixed names and also report its all-query estimate. Retained private graph variants can increase hypothetical materialize-every-query cost even while actual selected requests improve. Do not present targeted gains as global gains.

Run focused regression tests, dashboard and root lint, dashboard typecheck/document validation, and applicable browser/performance checks. Run memory checks when ingestion, storage, or the query engine changes; use the existing Postgres benchmark when applicable with a loopback/Unix-socket endpoint and isolated namespace.

Run `npm run compile` for Markdown changes and follow repository compiler guidance. If the shared installed compiler is too old, do not lower the manifest minimum or upgrade a shared tool without authority; use an isolated checksum-verified binary at the policy-pinned version and clean it up afterward.

If Playwright loads the populated full website and frontend code changed, capture affected desktop/mobile pages and publish evidence to the PR using `github-pr-media`. Wait for actual selected query rows in the owned view, not merely a visible page heading or absence of `aria-busy`. Account for lazy views and reset the desktop viewport before using desktop controls. Do not view screenshots before posting them or commit screenshots.

Compare broad failures with the recorded baseline. Repair introduced and coupled failures only; report unrelated failures and noisy Lighthouse score gates honestly without weakening thresholds. Stop preview servers and remove task-local helpers when finished.

## Completion report

Report the original selected names and before/after estimates, actual standalone and combined operation reductions, preserved contracts, integrated commits/PRs, and remaining baseline limitations. State the evidence dataset and ranking mode; do not claim fewer bytes or faster wall time from field-unit/operation counts alone.

Finish only when all selected workstreams are persistent, catalogs are reproducible, and the integrated outputs and improvement claims are verified.
