# ADR 2882: Populate dashboard pages from gh-aw logs data

## Status

Draft

## Context

Several dashboard pages lacked data because `gh aw logs --json` fields were discarded and experiment, grader, and eval sources were never populated. The dashboard's usage collector (`dashboard/report/aic-usage.mjs`) previously invoked `gh aw logs --json --artifacts` with the argument `"usage,agent,detection,firewall"`, which did not request eval, experiment, grader, or MCP artifacts. As a result, a run was only included in the `runs` map if `Number.isFinite(aic)`, meaning runs with token usage data but no AIC (AI credit) value were dropped, and fields such as the original run payload were discarded rather than retained on dashboard run records.

## Decision

Expand gh-aw log collection to request the additional artifact types `evals`, `experiment`, `graders`, and `mcp` (changing the `--artifacts` argument to `"usage,agent,detection,evals,experiment,firewall,graders,mcp"`), and normalize the resulting data into the dashboard's Usage, Experiment, Grader, and Eval sources:

- Retain the original run payload on dashboard run records (`data: run.data ?? null`), and add new fields `tokenUsage`, `experiments`, and `graders` populated from the run object.
- Add a `tokenUsage(run)` function that extracts input/output/cache-read/cache-write/reasoning token counts from `run.token_usage_summary`, returning `null` when the summary is absent.
- Add a `readRunEvals(outputDirectory, runId)` function that reads `evals.jsonl` files under the run's output directory and extracts eval observations (id, answer, runId, timestamp), skipping malformed lines silently, read concurrently with security telemetry via `Promise.all`.
- Change AIC parsing to explicitly treat null/undefined/empty-string as `null` instead of coercing to `NaN`, preserving an "unknown" state distinctly rather than inventing a value.
- Include a run in the `runs` map if `Number.isFinite(aic)` OR `common.tokenUsage` is truthy, instead of requiring a finite `aic`, so runs with token usage but no AIC are no longer dropped.
- Expose `data` and `logs-payload` on run records in the dashboard contract, register the newly populated fields and sources in `dashboard/report/dashboard-language-sources.mjs` and `dashboard/site/src/specification.js`, and advance the cached usage schema to version 5.

Throughout, unavailable or unknown states are preserved rather than invented (e.g., `null` token usage, `null` AIC) so downstream dashboard consumers can distinguish "no data" from a default/zero value.

## Alternatives Considered

Not inferable from current pull request evidence — the PR body and diff do not describe alternative designs (e.g., a different artifact-collection mechanism, a different schema-versioning approach, or inventing default values instead of preserving unknown states) that were considered and rejected.

## Consequences

**Positive:**
- Dashboard pages that previously lacked data (experiment, grader, and eval views) are now populated, since their underlying sources are collected and normalized.
- Runs with token usage but no AIC value are no longer silently dropped from the `runs` map, improving data completeness.
- Preserving "unavailable"/"unknown" states (`null` rather than `NaN` or `0`) avoids inventing misleading default values in the dashboard.
- Retaining the original run payload (`data`, `logs-payload`) gives dashboard consumers access to raw data for future use without requiring another collection change.

**Negative:**
- Requesting more artifact types (`evals,experiment,graders,mcp` in addition to `usage,agent,detection,firewall`) increases the volume of data collected per `gh aw logs` invocation, which may increase collection time or resource usage (not quantified in the evidence).
- Advancing the cached usage schema to version 5 implies existing cached data at prior schema versions is no longer valid in its old shape, requiring consumers to handle the schema bump (specific migration behavior is not inferable from current pull request evidence).
- The broadened inclusion criterion for the `runs` map (finite `aic` OR truthy `tokenUsage`) changes which runs appear in dashboard output compared to before, which could affect any downstream logic or reports relying on the previous, narrower set of runs.
