// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { performanceSnapshotTimestamp } from '../performance/lighthouse-contract.js';
import { ingestNormalizedJsonl, finalizeNormalizedJsonlIngestion } from '../../src/data/ingest/coordinator.js';
import { readCollection } from '../../src/data/storage/indexeddb.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';

it('measures an old published snapshot without aging all its detailed evidence out', async () => {
  const indexedDB = new IDBFactory();
  const payload = [
    { kind: 'metadata', schemaVersion: CANONICAL_SCHEMA_VERSION, ingestionVersion: 4, phase: 'all', records: 3 },
    { kind: 'record', collection: 'audits', record: {
      id: 'audit:recent', timestamp: '2026-10-08T13:00:00Z', summary: 'Specific evidence'
    } },
    { kind: 'record', collection: 'audits', record: {
      id: 'audit:expired', timestamp: '2026-09-30T13:00:00Z', summary: 'Expired evidence'
    } },
    { kind: 'record', collection: 'repositories', record: {
      id: 'repo:1', observedAt: '2026-10-15T13:00:00Z'
    } }
  ].map((envelope) => JSON.stringify(envelope)).join('\n');
  const now = performanceSnapshotTimestamp(payload);
  expect(now).toBe(Date.parse('2026-10-08T13:00:00Z'));
  await ingestNormalizedJsonl(indexedDB, (async function* () { yield payload; })(), {
    now, payloadIdentity: 'snapshot', payloadScope: 'snapshot', deferMaintenance: true
  });
  await finalizeNormalizedJsonlIngestion(indexedDB, { now });
  expect((await readCollection(indexedDB, 'audits')).map((audit) => audit.id)).toEqual(['audit:recent']);
});

it('uses canonical run retention timestamps and fails closed without dated evidence', () => {
  expect(performanceSnapshotTimestamp(JSON.stringify({
    kind: 'record', collection: 'runs', record: {
      completedAt: '2026-10-08T14:00:00Z', startedAt: '2026-10-08T13:00:00Z',
      observedAt: '2026-10-15T13:00:00Z'
    }
  }))).toBe(Date.parse('2026-10-08T14:00:00Z'));
  expect(performanceSnapshotTimestamp('{"kind":"metadata"}\n')).toBe(-Infinity);
  expect(performanceSnapshotTimestamp(JSON.stringify({
    kind: 'record', collection: 'audits', record: { timestamp: 'invalid' }
  }))).toBe(-Infinity);
});
