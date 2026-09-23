import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { ingestNormalizedJsonl } from "../../dashboard/site/src/data/ingest/coordinator.js";
import {
  DATABASE_NAME,
  deleteCanonicalDatabase,
  readCollection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";
import {
  deployedActivityShardEntries,
  legacyPhaseJsonToJsonl,
} from "../e2e/dashboard-deployed-refresh-helpers.mjs";

const deployedManifestUrl = process.env.DASHBOARD_DATA_URL
  || "https://githubnext.github.io/gh-aw-cao/cao/payload-hashes.json";
const transientDownloadStatuses = new Set([408, 429, 500, 502, 503, 504]);

async function fetchDeployedData(url) {
  const maximumAttempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok || !transientDownloadStatuses.has(response.status) || attempt === maximumAttempts) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
  }
}

async function ingestDeployedShards() {
  const response = await fetchDeployedData(deployedManifestUrl);
  assert.equal(response.ok, true, `failed to download ${deployedManifestUrl}: ${response.status}`);
  const manifest = await response.json();
  for (const { name, sourceName, hash } of deployedActivityShardEntries(manifest)) {
    const shardUrl = new URL(sourceName, deployedManifestUrl);
    const shard = await fetchDeployedData(shardUrl);
    assert.equal(shard.ok, true, `failed to download ${shardUrl}: ${shard.status}`);
    assert.ok(shard.body, `failed to stream ${shardUrl}`);
    const chunks = sourceName.endsWith(".json")
      ? new Response(legacyPhaseJsonToJsonl(Buffer.from(await shard.arrayBuffer()))).body
      : shard.body;
    await ingestNormalizedJsonl(indexedDB, chunks, {
      payloadIdentity: hash,
      payloadScope: name,
      expectedPhase: name.startsWith("gh-aw-logs-runs/") ? "runs" : "records",
    });
  }
}

test.before(async () => {
  await deleteCanonicalDatabase(indexedDB);
  await ingestDeployedShards();
});

test.after(async () => {
  await deleteCanonicalDatabase(indexedDB);
});

test("deployed dashboard cache populates canonical workflows, runs, and run records", async () => {
  const [repositories, workflows, runs, domains, tools, audits, issues] = await Promise.all([
    readCollection(indexedDB, "repositories"),
    readCollection(indexedDB, "workflows"),
    readCollection(indexedDB, "runs"),
    readCollection(indexedDB, "domains"),
    readCollection(indexedDB, "tools"),
    readCollection(indexedDB, "audits"),
    readCollection(indexedDB, "issues"),
  ]);
  for (const [table, entries] of Object.entries({ repositories, workflows, runs })) {
    console.error(`Canonical ${table} rows: ${entries.length}`);
    assert.ok(entries.length > 0, `canonical ${table} table must contain an entry`);
  }
  assert.ok(domains.length + tools.length + audits.length + issues.length > 0);
});

test("deployed dashboard cache ingests its firewall analysis", async () => {
  const ingestedFirewallEvents = (await readCollection(indexedDB, "domains")).filter(
    (event) => event.source === "firewall" && /^net_/.test(String(event.type)),
  );
  assert.ok(ingestedFirewallEvents.length > 0, "deployed gh-aw logs must ingest firewall events");
  assert.ok(
    ingestedFirewallEvents.every((event) => Number(event.requestCount) > 0),
    "ingested firewall events must retain positive request counts",
  );
});
