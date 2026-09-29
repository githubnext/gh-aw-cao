import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const require = createRequire(new URL('../../../../dashboard/site/package.json', import.meta.url));
require('fake-indexeddb/auto');

const { ingestNormalizedJsonl } = await import('../../../../dashboard/site/src/data/ingest/coordinator.js');
const { queryDatabaseSources } = await import('../../../../dashboard/site/src/data/queries/database.js');
const { readCollection } = await import('../../../../dashboard/site/src/data/storage/indexeddb.js');

const names = {
  experiments: 'experiments',
  experimentAssignments: 'experiment-assignments',
  graders: 'graders',
  graderObservations: 'grader-observations',
  evals: 'evals',
  evalObservations: 'eval-observations'
};

for (const [phase, path] of [['runs', process.argv[2]], ['records', process.argv[3]]]) {
  const content = await readFile(path);
  async function* chunks() {
    yield content.subarray(0, 97);
    yield content.subarray(97);
  }
  const result = await ingestNormalizedJsonl(indexedDB, chunks(), {
    payloadIdentity: createHash('sha256').update(content).digest('hex'),
    payloadScope: path,
    expectedPhase: phase,
    now: Date.parse('2026-09-24T00:00:00Z')
  });
  if (!result.updated) throw new Error(`${phase} shard was not ingested`);
}

const canonicalCounts = {};
for (const name of Object.keys(names)) {
  canonicalCounts[name] = (await readCollection(indexedDB, name)).length;
}
const projected = await queryDatabaseSources(indexedDB, {}, Object.values(names));
const rows = Object.fromEntries(Object.values(names).map((name) => [name, projected[name].rows]));
console.log(JSON.stringify({ canonicalCounts, rows }));
