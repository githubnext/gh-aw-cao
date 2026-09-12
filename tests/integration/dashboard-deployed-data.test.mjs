import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { ingestCachedGhAwJsonl } from "../../dashboard/site/src/data/ingest/coordinator.js";
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  readCollection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";

const deployedLogsUrl = process.env.GH_AW_LOGS_URL
  || "https://githubnext.github.io/gh-aw-cao/cao/gh-aw-logs.jsonl";

async function deployedLogs() {
  const response = await fetch(deployedLogsUrl, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.ok, true, `failed to download ${deployedLogsUrl}: ${response.status}`);
  return response.text();
}

test("deployed dashboard cache populates canonical workflows, runs, and events", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    await ingestCachedGhAwJsonl(indexedDB, await deployedLogs());
    const [repositories, workflows, runs, jobs, sessions, events] = await Promise.all([
      readCollection(indexedDB, "repositories"),
      readCollection(indexedDB, "workflows"),
      readCollection(indexedDB, "runs"),
      readCollection(indexedDB, "jobs"),
      readCollection(indexedDB, "sessions"),
      readCollection(indexedDB, "events"),
    ]);
    for (const [table, entries] of Object.entries({
      repositories,
      workflows,
      runs,
      jobs,
      sessions,
      events,
    })) {
      console.error(`Canonical ${table} rows: ${entries.length}`);
      assert.ok(entries.length > 0, `canonical ${table} table must contain an entry`);
    }
  } finally {
    await deleteCanonicalDatabase(indexedDB);
  }
});

test("deployed dashboard cache ingests its top-level firewall analysis", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    const logsContent = await deployedLogs();
    const logs = logsContent.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.ok(logs.some(({ run }) => (
      run?.firewall_analysis?.requests_by_domain
      && Object.keys(run.firewall_analysis.requests_by_domain).length > 0
    )), "deployed gh-aw logs must contain top-level firewall analysis");

    await ingestCachedGhAwJsonl(indexedDB, logsContent);
    const ingestedFirewallEvents = (await readCollection(indexedDB, "events")).filter(
      (event) => event.source === "firewall" && /^net_/.test(String(event.type)),
    );
    assert.ok(ingestedFirewallEvents.length > 0, "deployed gh-aw logs must ingest firewall events");
    assert.ok(
      ingestedFirewallEvents.every((event) => Number(event.requestCount) > 0),
      "ingested firewall events must retain positive request counts",
    );
  } finally {
    await deleteCanonicalDatabase(indexedDB);
  }
});
