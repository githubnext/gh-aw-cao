import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import ledger from '../fixtures/operational-value-ledger.json' with { type: 'json' };
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { DATABASE_NAME, maintainCanonicalDatabase, readCollection } from '../../src/data/storage/indexeddb.js';
import { mergeRetainedRecords } from '../../src/data/storage/retention.js';
import { normalize } from '../../src/data/normalize/index.js';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';

/** @param {unknown} input */
const operationalValueEvidenceJsonl = input => execFileSync(process.execPath,
  ['../../.github/skills/add-operational-value/scripts/export-evidence.mjs'],
  { input: JSON.stringify(input), encoding: 'utf8' });
/** @param {unknown} input */
const exportOperationalValueEvidence = input => JSON.parse(operationalValueEvidenceJsonl(input)).operational_value_evidence;

afterEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical operational value evidence', () => {
  it('queries flat facts only through normal worker database sources and keeps atomic replacement', async () => {
    await ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(ledger));
    const sources = await queryDatabaseSources(indexedDB, {}, ['operational-value-evidence']);
    expect(sources['operational-value-evidence'].metadata).toMatchObject({
      'as-of': ledger.window.endAt, 'retrieved-at': ledger.observedAt,
      completeness: 'unknown', freshness: 'unknown'
    });
    const [workflow] = await readCollection(indexedDB, 'workflows');
    expect(workflow).toMatchObject({ name: ledger.workflowName, path: ledger.sourcePath, state: 'unknown' });
    expect(workflow.registryState).toBeUndefined();
    expect(sources['operational-value-evidence'].rows).toContainEqual(expect.objectContaining({
      'fact-kind': 'contract', 'workflow-name': 'Verify bugs', 'output-unit': 'issues'
    }));
    const replacement = structuredClone(ledger);
    replacement.observedAt = '2026-10-21T00:00:00Z';
    replacement.intent.requirements = ['Only the current coherent requirements.'];
    // The intent is frozen; changing it without a metric version must fail.
    await expect(ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(replacement))).rejects.toThrow(/contract changed/);
    const fresh = structuredClone(ledger);
    fresh.observedAt = '2026-10-21T00:00:00Z';
    fresh.checks = [];
    await ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(fresh));
    const updated = await queryDatabaseSources(indexedDB, {}, ['operational-value-evidence']);
    expect(updated['operational-value-evidence'].rows.some(row => row['fact-kind'] === 'quality-check')).toBe(false);
    expect((await readCollection(indexedDB, 'operationalValueEvidence'))).toHaveLength(1);
    const stale = structuredClone(ledger);
    stale.checks = [];
    await ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(stale));
    expect((await readCollection(indexedDB, 'operationalValueEvidence'))[0].observedAt).toBe(fresh.observedAt);
    const conflicting = structuredClone(ledger);
    conflicting.observedAt = fresh.observedAt;
    await expect(ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(conflicting)))
      .rejects.toThrow(/same capture/);
    const result = executeDashboardQueries([{
      name: 'count-facts', from: 'operational-value-evidence',
      aggregate: { values: [{ field: 'fact-id', as: 'facts', reducer: 'count' }] }
    }], updated, ['count-facts']);
    expect(result['count-facts'].rows[0].facts).toBe(exportOperationalValueEvidence(fresh).facts.length);
    expect(result['count-facts'].metadata['retrieved-at']).toBe(fresh.observedAt);
    await maintainCanonicalDatabase(indexedDB, {
      now: Date.parse('2027-10-20T00:00:00Z'), maxDatabaseBytes: 100 * 1024 * 1024,
      reconcileRelationships: true
    });

    expect(await readCollection(indexedDB, 'workflows')).toHaveLength(1);
    expect(await readCollection(indexedDB, 'operationalValueEvidence')).toHaveLength(1);
  });

  it('does not infer a measured empty item population from omitted retained items', async () => {
    const missingItems = structuredClone(ledger);
    const observation = /** @type {Record<string, unknown>} */ (missingItems.repositoryState.observations[1]);
    delete observation.items;
    await ingestCachedGhAwJsonl(indexedDB, operationalValueEvidenceJsonl(missingItems));
    const sources = await queryDatabaseSources(indexedDB, {}, ['operational-value-evidence']);
    const snapshots = sources['operational-value-evidence'].rows.filter(row => row['fact-kind'] === 'snapshot');
    expect(snapshots.map(row => row['items-available'])).toEqual([true, false]);
  });

  it('retains evidence and its repository independently of run detail expiry', () => {
    const previous = normalize(adaptCachedGhAwJsonl(operationalValueEvidenceJsonl(ledger)).observations);
    const empty = normalize([]);
    const retained = mergeRetainedRecords(previous, empty, { now: Date.parse('2027-10-20T00:00:00Z') });
    expect(retained.operationalValueEvidence).toHaveLength(1);
    expect(retained.repositories).toHaveLength(1);
    expect(retained.workflows).toHaveLength(1);
    expect(retained.runs).toHaveLength(0);
  });
});
