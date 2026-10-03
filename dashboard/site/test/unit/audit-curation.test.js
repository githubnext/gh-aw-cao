import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBCursor, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { discardAudit } from '../../src/data/model/audit-curation.js';
import { normalize } from '../../src/data/normalize/index.js';
import { ingestNormalizedJsonl, isAuditCurationCurrent, finalizeNormalizedJsonlIngestion } from '../../src/data/ingest/coordinator.js';
import { maintainCanonicalDatabase, readCollection, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';

/** @type {{run: Record<string, unknown>, audit: Record<string, unknown>, cases: {name: string, audit: Record<string, unknown>, run?: Record<string, unknown> | null, drop: boolean}[]}} */
const fixture = JSON.parse(readFileSync(resolve('../../tests/fixtures/audit-curation.json'), 'utf8'));
const NOW = Date.parse('2026-10-02T14:00:00Z');
const options = { now: NOW, maxDatabaseBytes: Number.MAX_SAFE_INTEGER };

function batch() {
  const result = normalize([]);
  result.repositories = [{ id: 'repository:curation', owner: 'example', name: 'project' }];
  result.workflows = [{ id: 'workflow:curation', repositoryId: 'repository:curation' }];
  result.runs = [{
    ...fixture.run,
    repositoryId: 'repository:curation',
    workflowId: 'workflow:curation'
  }];
  result.audits = fixture.cases.filter((entry) =>
    entry.run === undefined && entry.audit.timestamp !== 'invalid'
  ).map((entry) => ({ ...fixture.audit, ...entry.audit, id: entry.name }));
  return result;
}

describe('first-pass canonical Audit curation', () => {
  for (const entry of fixture.cases) {
    it(entry.name, () => {
      const run = entry.run === null ? null : { ...fixture.run, ...entry.run };
      expect(discardAudit({ ...fixture.audit, ...entry.audit, id: entry.name }, run)).toBe(entry.drop);
    });
  }

  it('retains additional unknown nonnull evidence and a different owning Run', () => {
    const audit = { ...fixture.audit, type: 'workflow_run_usage', summary: 'AIC 12.5' };
    expect(discardAudit({ ...audit, diagnosis: 'Specific evidence' }, fixture.run)).toBe(false);
    expect(discardAudit(audit, { ...fixture.run, id: 'run:other' })).toBe(false);
  });

  it('retains oversized numeric summaries without parsing them', () => {
    const audit = { ...fixture.audit, type: 'workflow_run_usage', summary: `AIC 0.${'0'.repeat(1024)}` };
    expect(discardAudit(audit, { ...fixture.run, aicTotal: 0 })).toBe(false);
  });

  it('cleans an existing database idempotently without reading whole collections', async () => {
    const indexedDB = new IDBFactory();
    const incoming = batch();
    await upsertCanonicalBatch(indexedDB, incoming);
    expect(await isAuditCurationCurrent(indexedDB)).toBe(false);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const maintained = await maintainCanonicalDatabase(indexedDB, options);
    expect(getAll).not.toHaveBeenCalled();
    getAll.mockRestore();
    expect(maintained.prunedAudits).toBe(incoming.audits.filter((audit) => discardAudit(audit, incoming.runs[0])).length);
    expect(maintained.prunedAudits).toBeGreaterThan(0);
    expect(await isAuditCurationCurrent(indexedDB)).toBe(true);
    const retained = await readCollection(indexedDB, 'audits');
    expect(retained.map((audit) => audit.id).sort()).toEqual(
      incoming.audits.filter((audit) => !discardAudit(audit, incoming.runs[0])).map((audit) => audit.id).sort()
    );
    expect((await maintainCanonicalDatabase(indexedDB, options)).prunedAudits).toBe(0);
  });

  it('preserves referenced Audit identities during persisted cleanup', async () => {
    const indexedDB = new IDBFactory();
    const incoming = batch();
    incoming.experiments = [{ id: 'experiment:curation', workflowId: 'workflow:curation' }];
    incoming.experimentAssignments = [{
      id: 'assignment:curation', runId: fixture.run.id, experimentId: 'experiment:curation',
      timestamp: fixture.audit.timestamp, auditId: 'working-set-marker'
    }];
    await upsertCanonicalBatch(indexedDB, incoming);
    await maintainCanonicalDatabase(indexedDB, options);
    expect((await readCollection(indexedDB, 'audits')).some((audit) => audit.id === 'working-set-marker')).toBe(true);
  });

  it('batches Audit deletions without invalidating cursor prefetch per record', async () => {
    const indexedDB = new IDBFactory();
    const incoming = batch();
    incoming.audits = Array.from({ length: 2105 }, (_, index) => ({
      ...fixture.audit, id: `audit:${String(index).padStart(4, '0')}`,
      type: 'workflow_run_working_set', status: 'observed', summary: 'Working set measured'
    }));
    incoming.audits.push({
      ...fixture.audit, id: 'audit:retained', type: 'workflow_run_working_set',
      status: 'observed', summary: 'Working set measured', diagnosis: 'Specific evidence'
    });
    await upsertCanonicalBatch(indexedDB, incoming);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const cursorDelete = vi.spyOn(IDBCursor.prototype, 'delete');
    const originalDelete = IDBObjectStore.prototype.delete;
    const storeDelete = vi.spyOn(IDBObjectStore.prototype, 'delete');
    /** @type {number[]} */
    const pendingDeletes = [];
    let auditCursorReads = 0;
    const originalOpenCursor = IDBObjectStore.prototype.openCursor;
    const openCursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(/** @this {IDBObjectStore} */ function (...args) {
      const request = originalOpenCursor.apply(this, args);
      if (this.name === 'audits') {
        request.addEventListener('success', () => {
          if (request.result) auditCursorReads += 1;
        });
      }
      return request;
    });
    storeDelete.mockImplementation(/** @this {IDBObjectStore} */ function (key) {
      if (this.name === 'audits') pendingDeletes.push(auditCursorReads);
      return originalDelete.call(this, key);
    });
    try {
      const maintained = await maintainCanonicalDatabase(indexedDB, options);
      expect(maintained.prunedAudits).toBe(2105);
      expect(getAll).not.toHaveBeenCalled();
      expect(cursorDelete).not.toHaveBeenCalled();
      expect(pendingDeletes.slice(0, 1000)).toEqual(Array(1000).fill(1000));
      expect(pendingDeletes.slice(1000, 2000)).toEqual(Array(1000).fill(2000));
      expect(pendingDeletes.slice(2000)).toEqual(Array(105).fill(2106));
    } finally {
      getAll.mockRestore();
      cursorDelete.mockRestore();
      storeDelete.mockRestore();
      openCursor.mockRestore();
    }
    expect((await readCollection(indexedDB, 'audits')).map((audit) => audit.id)).toEqual(['audit:retained']);
    expect((await maintainCanonicalDatabase(indexedDB, options)).prunedAudits).toBe(0);
  }, 15000);

  it('validates old transport counts before pruning and cleans unchanged shards', async () => {
    const indexedDB = new IDBFactory();
    const incoming = batch();
    await upsertCanonicalBatch(indexedDB, { ...incoming, audits: [] });
    const envelopes = [
      { kind: 'metadata', schemaVersion: 25, ingestionVersion: 4, phase: 'records', records: incoming.audits.length },
      ...incoming.audits.map((record) => ({ kind: 'record', collection: 'audits', record }))
    ];
    const payload = envelopes.map((envelope) => JSON.stringify(envelope)).join('\n');
    const ingestionOptions = {
      ...options, payloadIdentity: 'audit-curation-fixture', payloadScope: 'audit-curation-fixture',
      expectedPhase: /** @type {const} */ ('records'), deferMaintenance: true
    };
    const stream = async function* () { yield payload; };
    const first = await ingestNormalizedJsonl(indexedDB, stream(), ingestionOptions);
    expect(first.committedRecords).toBe(incoming.audits.length);
    const second = await ingestNormalizedJsonl(indexedDB, stream(), ingestionOptions);
    expect('skipped' in second && second.skipped).toBe(true);
    expect(await isAuditCurationCurrent(indexedDB)).toBe(false);
    const cleanup = await finalizeNormalizedJsonlIngestion(indexedDB, options);
    expect(cleanup.prunedAudits).toBeGreaterThan(0);
    expect(await isAuditCurationCurrent(indexedDB)).toBe(true);
  });
});
