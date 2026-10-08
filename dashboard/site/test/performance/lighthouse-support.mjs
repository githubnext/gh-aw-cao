import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deployedActivityShardEntries } from '../../../../tests/e2e/dashboard-deployed-refresh-helpers.mjs';
import { downloadDeployedDashboardData } from '../../../../tests/e2e/dashboard-view-data.mjs';

const digest = (body) => createHash('sha256').update(body).digest('hex');

export async function preparePerformanceData(fullRoot, emptyRoot, sourceUrl, local = false) {
  let manifest;
  if (local) {
    manifest = JSON.parse(await readFile(join(fullRoot, 'payload-hashes.json'), 'utf8'));
  } else {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Dashboard manifest download failed: HTTP ${response.status}.`);
    manifest = await response.json();
    await downloadDeployedDashboardData(fullRoot, sourceUrl, (input) => (
      String(input) === String(sourceUrl) ? Promise.resolve(Response.json(manifest)) : fetch(input)
    ));
    await writeFile(join(fullRoot, 'payload-hashes.json'), JSON.stringify(manifest));
  }
  const shards = deployedActivityShardEntries(manifest);
  let bytes = 0;
  for (const shard of shards) {
    if (shard.sourceName !== shard.name) throw new Error('Performance audits require normalized JSONL shards.');
    const body = await readFile(join(fullRoot, shard.name));
    if (digest(body) !== shard.hash) throw new Error(`Dashboard shard hash mismatch: ${shard.name}`);
    bytes += body.length;
  }
  const first = JSON.parse((await readFile(join(fullRoot, shards[0].name), 'utf8')).split('\n')[0]);
  if (first.kind !== 'metadata') throw new Error('Dashboard shard metadata is missing.');
  const emptyManifest = {};
  for (const phase of ['runs', 'records']) {
    const body = JSON.stringify({ ...first, sourceRecords: 0, records: 0, phase }) + '\n';
    const hash = digest(body);
    const name = `gh-aw-logs-${phase}/empty-${hash.slice(0, 16)}.jsonl`;
    await mkdir(dirname(join(emptyRoot, name)), { recursive: true });
    await writeFile(join(emptyRoot, name), body);
    emptyManifest[name] = hash;
  }
  const inventory = JSON.parse(await readFile(join(fullRoot, 'inventory-sources.json'), 'utf8'));
  for (const source of Object.values(inventory)) {
    if (!Array.isArray(source.rows)) throw new Error('Dashboard inventory source rows are invalid.');
    source.rows = [];
  }
  await writeFile(join(emptyRoot, 'inventory-sources.json'), JSON.stringify(inventory));
  await writeFile(join(emptyRoot, 'payload-hashes.json'), JSON.stringify(emptyManifest));
  await mkdir(join(emptyRoot, 'memory'), { recursive: true });
  await writeFile(join(emptyRoot, 'memory/manifest.json'), '{"version":1,"campaigns":[]}');
  return { sourceUrl, manifestSha256: digest(JSON.stringify(manifest)), shards: shards.length, bytes };
}

export function instrumentPerformancePage() {
  Reflect.set(window, '__dashboardPerformanceRefresh', null);
  document.addEventListener('dashboard-data', (event) => {
    if (event instanceof CustomEvent && event.detail?.kind === 'refresh') {
      Reflect.set(window, '__dashboardPerformanceRefresh', event.detail);
    }
  });
}

export async function canonicalCounts(page) {
  return page.evaluate(async () => {
    const descriptor = (await indexedDB.databases()).find(({ name }) => name?.startsWith('gh-aw-cao-dashboard-data'));
    if (!descriptor?.name) throw new Error('Canonical dashboard database was not created.');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(descriptor.name, descriptor.version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return Object.fromEntries(await Promise.all([...database.objectStoreNames].map((store) => (
        new Promise((resolve, reject) => {
          const request = database.transaction(store).objectStore(store).count();
          request.onsuccess = () => resolve([store, request.result]);
          request.onerror = () => reject(request.error);
        })
      ))));
    } finally {
      database.close();
    }
  });
}
