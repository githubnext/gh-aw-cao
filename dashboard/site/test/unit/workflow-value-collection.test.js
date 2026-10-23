// @vitest-environment node
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { validateWorkflowValueCollection } from '../../src/data/model/workflow-value-collection.js';
import { maintainCanonicalDatabase, readCollection } from '../../src/data/storage/indexeddb.js';

const source = readFileSync(new URL('../fixtures/workflow-value-collection.jsonl', import.meta.url), 'utf8');
const fixture = JSON.parse(source);

describe('canonical workflow Value collection facts', () => {
  it('fails closed on contradictory states, clocks, identities and measurements disguised as health', () => {
    const record = fixture.workflow_value_collection;
    expect(validateWorkflowValueCollection(record)).toEqual(record);
    for (const changes of [
      { registration: 'disabled' }, { state: 'available' }, { reason: 'invented' },
      { lastAttemptAt: '2026-10-24T12:00:00Z' }, { lastAttemptOutcome: 'deferred' },
      { id: 'wrong' }, { collector: '../escape.mjs' }, { value: 0 }, { capturedAt: record.observedAt },
      { workflowId: 'workflow:other' }, { schemaVersion: '1' }
    ]) expect(() => validateWorkflowValueCollection({ ...record, ...changes })).toThrow();
    expect(adaptCachedGhAwJsonl(source).observations.map(item => item.kind))
      .toEqual(['repository', 'workflow', 'workflow-value-collection']);
  });

  it('preserves independent attempt clocks, rejects conflicting decisions, and retains structural parents without runs', async () => {
    const database = new IDBFactory();
    const now = Date.parse('2026-10-25T00:00:00Z');
    await ingestCachedGhAwJsonl(database, source, { now, payloadScope: 'health' });
    const older = structuredClone(fixture);
    older.workflow_value_collection.observedAt = '2026-10-22T13:00:00Z';
    await ingestCachedGhAwJsonl(database, JSON.stringify(older), { now, payloadScope: 'older' });
    const [retained] = await readCollection(database, 'workflowValueCollections');
    expect(retained.observedAt).toBe(fixture.workflow_value_collection.observedAt);
    const conflicting = structuredClone(fixture);
    conflicting.workflow_value_collection.policyDigest = 'c'.repeat(64);
    await expect(ingestCachedGhAwJsonl(database, JSON.stringify(conflicting), { now, payloadScope: 'conflict' })).rejects.toThrow();
    const regressed = structuredClone(fixture);
    regressed.workflow_value_collection.observedAt = '2026-10-24T00:00:00Z';
    delete regressed.workflow_value_collection.lastAttemptAt;
    delete regressed.workflow_value_collection.lastAttemptOutcome;
    await expect(ingestCachedGhAwJsonl(database, JSON.stringify(regressed), { now, payloadScope: 'regression' })).rejects.toThrow();
    await maintainCanonicalDatabase(database, {
      now: now + 365 * 86400000, retentionWindowMs: 86400000, maxDatabaseBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(await readCollection(database, 'workflowValueCollections')).toHaveLength(1);
    expect(await readCollection(database, 'repositories')).toHaveLength(1);
    expect(await readCollection(database, 'workflows')).toHaveLength(1);
    expect(await readCollection(database, 'runs')).toEqual([]);
  });
});
