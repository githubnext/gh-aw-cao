import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { ingestCachedGhAwJsonl } from "../../dashboard/site/src/data/ingest/coordinator.js";
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  readCollection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";

const deployedManifestUrl = process.env.DASHBOARD_DATA_URL
  || "https://githubnext.github.io/gh-aw-cao/cao/payload-hashes.json";

async function ingestDeployedShards() {
  const response = await fetch(deployedManifestUrl, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.ok, true, `failed to download ${deployedManifestUrl}: ${response.status}`);
  const manifest = await response.json();
  for (const name of Object.keys(manifest).filter((name) => name.startsWith("gh-aw-logs-shards/")).sort()) {
    const shardUrl = new URL(name, deployedManifestUrl);
    const shard = await fetch(shardUrl, { signal: AbortSignal.timeout(60_000) });
    assert.equal(shard.ok, true, `failed to download ${shardUrl}: ${shard.status}`);
    assert.ok(shard.body, `failed to stream ${shardUrl}`);
    await ingestCachedGhAwJsonl(indexedDB, shard.body, { payloadScope: name });
  }
}

test("deployed dashboard cache populates canonical workflows, runs, and events", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    await ingestDeployedShards();
    const [repositories, workflows, runs, events] = await Promise.all([
      readCollection(indexedDB, "repositories"),
      readCollection(indexedDB, "workflows"),
      readCollection(indexedDB, "runs"),
      readCollection(indexedDB, "events"),
    ]);
    for (const [table, entries] of Object.entries({
      repositories,
      workflows,
      runs,
      events,
    })) {
      console.error(`Canonical ${table} rows: ${entries.length}`);
      assert.ok(entries.length > 0, `canonical ${table} table must contain an entry`);
    }
  } finally {
    await deleteCanonicalDatabase(indexedDB);
  }
});

test("deployed dashboard cache ingests its firewall analysis", async () => {
  await deleteCanonicalDatabase(indexedDB);
  try {
    await ingestDeployedShards();
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
