import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installSqliteIndexedDB } from '../dashboard/site/src/data/storage/sqlite-indexeddb.js';
import { ingestCachedGhAwJsonl } from '../dashboard/site/src/data/ingest/coordinator.js';

// The Go host stages only the local delta and atomically publishes it after
// this process succeeds. Canonical ingestion sees the attached historical rows.
export async function ingestLocalBackfill(database, snapshotPath, snapshotRevision, directory) {
  const indexedDB = installSqliteIndexedDB(database, { snapshotPath, snapshotRevision });
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    await ingestCachedGhAwJsonl(indexedDB, createReadStream(path.join(directory, name)), {
      payloadScope: `local-backfill:${name}`,
      deferMaintenance: true,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [database, snapshot, revision, directory] = process.argv.slice(2);
  ingestLocalBackfill(database, snapshot, revision, directory).catch(() => {
    console.error('Canonical local backfill ingestion failed; the active overlay was not replaced');
    process.exitCode = 1;
  });
}
