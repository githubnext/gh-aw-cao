import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { installSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';
import { ingestDashboardSources, ingestNormalizedJsonl, finalizeNormalizedJsonlIngestion } from '../../src/data/ingest/coordinator.js';

/**
 * Prepare canonical evidence offline; the canvas itself never ingests browser sources.
 * @param {string} destination
 * @param {{ sources?: Record<string, unknown>, shards?: string[] }} [options]
 */
export async function writeCanvasArtifact(destination, { sources = {}, shards = [] } = {}) {
  await mkdir(destination, { recursive: true });
  const snapshot = join(destination, 'gh-aw-logs.sqlite');
  const indexedDB = installSqliteIndexedDB(snapshot);
  await ingestDashboardSources(indexedDB, sources);
  for (const [index, content] of shards.entries()) {
    await ingestNormalizedJsonl(indexedDB, Readable.from([content]), {
      payloadIdentity: createHash('sha256').update(content).digest('hex'),
      payloadScope: `fixture:${index}`, deferMaintenance: true
    });
  }
  if (shards.length) await finalizeNormalizedJsonlIngestion(indexedDB);
  await writeFile(join(destination, 'payload-hashes.json'), JSON.stringify({
    'gh-aw-logs.sqlite': createHash('sha256').update(await readFile(snapshot)).digest('hex')
  }));
  await writeFile(join(destination, 'inventory-sources.json'), JSON.stringify(sources));
}
