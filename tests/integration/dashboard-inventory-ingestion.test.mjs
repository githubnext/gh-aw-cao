import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { buildInventoryDashboardSources } from "../../activity/inventory-sources.mjs";
import { ingestDashboardSources } from "../../dashboard/site/src/data/ingest/coordinator.js";
import {
  DATABASE_NAME,
  readCanonicalBatch,
} from "../../dashboard/site/src/data/storage/indexeddb.js";

test("allowed repositories flow from control settings into canonical storage", async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  const generatedAt = "2026-09-13T00:00:00Z";
  const sources = buildInventoryDashboardSources({
    repository: "acme/control",
    generatedAt,
    inventory: { generatedAt, bundles: [], workflows: [] },
    controlSettings: {
      allowed_repositories: ["acme/control", "acme/payments", "acme/storefront"],
      packages: {},
    },
  });

  await ingestDashboardSources(indexedDB, sources);
  const canonical = await readCanonicalBatch(indexedDB);

  assert.deepEqual(
    canonical.repositories.map(({ fullName }) => fullName).sort(),
    ["acme/control", "acme/payments", "acme/storefront"],
  );
});
