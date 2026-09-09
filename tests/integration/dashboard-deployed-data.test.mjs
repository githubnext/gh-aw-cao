import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { loadDashboardSources } from "../../dashboard/site/src/source-loader.js";
import { ingestDashboardSources } from "../../dashboard/site/src/data/ingest/coordinator.js";
import { runId, sourceId } from "../../dashboard/site/src/data/model/ids.js";
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  readActiveCollection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";

const deployedSourcesUrl = process.env.DASHBOARD_DATA_URL
  || "https://githubnext.github.io/gh-aw-cao/cao/sources.json";

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function runAttempt(row) {
  const attempt = Number(row["run-attempt"] ?? row.attempt);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
}

test("deployed dashboard sources populate canonical workflows, runs, and events", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    const sources = await loadDashboardSources(
      (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
      deployedSourcesUrl,
    );
    await ingestDashboardSources(indexedDB, sources);

    const expectedWorkflows = new Set(sources.workflows.rows.map((row) => sourceId(
      "workflow",
      "dashboard-sources",
      `${row.organization}/${row.repository}:${row.workflow}`.toLowerCase(),
    )));
    const expectedRuns = new Set(sources.runs.rows.map((row) => runId(
      row.run,
      runAttempt(row),
    )));
    const expectedEvents = new Set(sources.events.rows.map((row) => String(row.event)));
    const [workflows, runs, events] = await Promise.all([
      readActiveCollection(indexedDB, "workflows"),
      readActiveCollection(indexedDB, "runs"),
      readActiveCollection(indexedDB, "events"),
    ]);

    assert.ok(expectedWorkflows.size > 0, "deployed data must contain workflows");
    assert.ok(expectedRuns.size > 0, "deployed data must contain runs");
    assert.ok(expectedEvents.size > 0, "deployed data must contain events");
    assert.deepEqual(sorted(workflows.map(({ id }) => id)), sorted(expectedWorkflows));
    assert.deepEqual(sorted(runs.map(({ id }) => id)), sorted(expectedRuns));
    assert.deepEqual(sorted(events.map(({ id }) => id)), sorted(expectedEvents));
  } finally {
    await deleteCanonicalDatabase(indexedDB);
  }
});
