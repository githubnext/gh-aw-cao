// @vitest-environment node

import { readFileSync } from 'node:fs';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { projectAuditEvidence, AUDIT_PROJECTION_VERSION } from '../../src/data/model/audit-projection.js';
import { normalize } from '../../src/data/normalize/index.js';
import { maintainCanonicalDatabase, readCollection, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { ingestNormalizedJsonl } from '../../src/data/ingest/coordinator.js';

/** @type {{ clock: string, run: Record<string, unknown>, grader: Record<string, unknown>, result: Record<string, unknown>, audits: Record<string, unknown>[], represented: string[], residual: string[] }} */
const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/audit-projection.json', import.meta.url), 'utf8'));
const NOW = Date.parse(fixture.clock);

/** @returns {import('../../src/data/model/schema.js').CanonicalBatch} */
function batch() {
  return {
    ...normalize([]),
    repositories: [{ id: 'repo', owner: 'example', name: 'project' }],
    workflows: [{ id: 'w', repositoryId: 'repo', path: '.github/workflows/test.md' }],
    runs: [{ ...fixture.run }],
    graders: [{ ...fixture.grader }],
    graderObservations: [{ ...fixture.result }],
    audits: fixture.audits.map((audit, sequence) => ({
      runId: 'r', timestamp: fixture.clock, observedAt: fixture.clock, attempt: 1,
      sequence, sourceSequence: sequence, payloadRef: 'private-evidence#L1',
      provenance: { source: 'gh-aw-logs', sourceId: audit.id, observedAt: fixture.clock },
      ...audit
    }))
  };
}

describe('fresh-ingestion Audit information projection', () => {
  it('preserves independent evidence and source-reported severity in the shared fixture', () => {
    const input = batch();
    const { batch: output, receipt } = projectAuditEvidence(input);
    expect(output.audits.map((audit) => audit.id).sort()).toEqual(fixture.residual);
    expect(receipt.representedAudits).toBe(fixture.represented.length);
    expect(receipt.sourceClock).toBe(fixture.clock);
    expect(output.runs[0].taskDomainLabel).toBe('Code Fix');
    expect(output.runs[0].sessionLabel).toBe('Pi/copilot/gpt-5.4');
    expect(output.runs[0].assessmentHeavyExecution).toMatchObject({ status: 'medium' });
    expect(output.audits.find((audit) => audit.id === 'finding')?.status).toBe('high');
    expect(input.graderObservations?.[0].auditId).toBe('grader');
  });

  it('preserves unavailable, null diagnostics, historical measurement fields and both clocks', () => {
    const { batch: output } = projectAuditEvidence(batch());
    const result = output.graderObservations?.[0];
    if (!result) throw new Error('Expected projected grader observation');
    expect(result).toMatchObject({
      id: 'result', status: 'unavailable', value: null, observedUnit: 'historical-unit',
      observedDirection: null, message: null, error: 'Missing runtime helper',
      timestamp: '2026-10-07T11:59:00.000Z',
      auditEvidence: { originId: 'grader', timestamp: fixture.clock }
    });
    expect(Object.hasOwn(result, 'auditId')).toBe(false);
    expect(Object.hasOwn(result, 'observedDirection')).toBe(true);
  });

  it('retains absent attempt attribution and explicitly null source provenance', () => {
    const input = batch();
    delete input.audits[0].attempt;
    input.audits[1].provenance = null;
    const output = projectAuditEvidence(input).batch;
    expect(output.audits.map((audit) => audit.id)).toEqual(expect.arrayContaining(['behavior', 'session']));
  });

  it('represents Run summaries only when the exact facts agree', () => {
    const cases = [
      { type: 'workflow_run_started', status: 'completed', summary: 'Build', facts: { startedAt: fixture.clock }, slot: 'startedEvidence' },
      { type: 'workflow_run_completed', status: 'failure', summary: 'failure', facts: {}, slot: 'completedEvidence' },
      { type: 'workflow_run_failed', status: 'failure', summary: 'compiler', facts: { failureKind: 'compiler' }, slot: 'failureEvidence' },
      { type: 'workflow_run_usage', status: 'observed', summary: 'AIC 0', facts: { aicTotal: 0 }, slot: 'usageEvidence' },
      { type: 'workflow_run_safe_outputs', status: 'observed', summary: '0 safe output items', facts: { safeItemsCount: 0 }, slot: 'safeOutputCountEvidence' }
    ];
    for (const entry of cases) {
      const input = batch();
      input.graderObservations = [];
      Object.assign(input.runs[0], entry.facts);
      input.audits = [{ ...input.audits[0], id: 'copy', source: 'gh-aw-logs', type: entry.type, status: entry.status, summary: entry.summary }];
      const projected = projectAuditEvidence(input);
      expect(projected.batch.audits).toHaveLength(0);
      expect(projected.batch.runs[0][entry.slot]).toMatchObject({ originId: 'copy' });
      input.audits[0].summary = `${entry.summary} independent detail`;
      expect(projectAuditEvidence(input).batch.audits).toHaveLength(1);
    }
  });

  it('preserves individual safe-output occurrences rather than substituting a Run count', () => {
    const input = batch();
    input.graderObservations = [];
    const audit = { ...input.audits[0], id: 'action', source: 'safe-output', type: 'safe_output.created',
      status: 'created', summary: 'Created issue', correlationId: 'https://github.com/example/project/issues/1',
      safeOutputType: 'create_issue', githubEntityType: 'issue' };
    input.audits = [audit];
    input.issues = [{ ...audit, id: 'issue:1' }];
    expect(projectAuditEvidence(input).batch.audits).toHaveLength(0);
    input.audits.push({ ...audit, id: 'action-again' });
    expect(projectAuditEvidence(input).batch.audits).toHaveLength(2);
    expect(projectAuditEvidence(input).batch.issues).toHaveLength(1);
  });

  it('rewrites classified eval backlinks without inventing answers for unclassified evidence', () => {
    const input = batch();
    input.graderObservations = [];
    input.evals = [{ id: 'eval', workflowId: 'w', sourceEvalId: 'question' }];
    input.evalObservations = [{ id: 'answer', runId: 'r', evalId: 'eval', evalResult: 'UNKNOWN', status: 'observed', auditId: 'eval-audit' }];
    input.audits = [{ ...input.audits[0], id: 'eval-audit', source: 'audit', type: 'workflow_run_eval',
      status: 'observed', summary: 'Evaluation question', evidenceState: 'classified', evalId: 'question', answer: 'UNKNOWN' }];
    const output = projectAuditEvidence(input).batch;
    expect(output.audits).toHaveLength(0);
    expect(Object.hasOwn(output.evalObservations?.[0] ?? {}, 'auditId')).toBe(false);
    input.graderObservations = batch().graderObservations;
    const graderAudit = batch().audits.find((audit) => audit.id === 'grader');
    if (!graderAudit) throw new Error('Expected grader Audit');
    input.audits.push(graderAudit);
    if (!input.graderObservations?.[0] || !input.evalObservations?.[0]) throw new Error('Expected result owners');
    input.evalObservations[0].id = input.graderObservations[0].id;
    const overlapping = projectAuditEvidence(input).batch;
    expect(overlapping.graderObservations?.[0]).toMatchObject({ graderId: fixture.grader.id });
    expect(overlapping.evalObservations?.[0]).toMatchObject({ evalId: 'eval', evalResult: 'UNKNOWN' });
    expect(overlapping.evalObservations?.[0]).not.toHaveProperty('graderId');
    input.audits = [input.audits[0]];
    input.graderObservations = [];
    input.audits[0].evidenceState = 'unclassified';
    expect(projectAuditEvidence(input).batch.audits).toHaveLength(1);
  });

  it('retains unknown diagnostics, conflicting results, attempts and repeated source occurrences', () => {
    for (const patch of [{ diagnostics: { newDiagnostic: true } }, { attempt: 2 }, { unit: 'conflict' }]) {
      const input = batch();
      if (patch.unit && input.graderObservations?.[0]) input.graderObservations[0].observedUnit = 'recorded-unit';
      const audit = input.audits.find((audit) => audit.id === 'grader');
      if (!audit) throw new Error('Expected grader Audit');
      Object.assign(audit, patch);
      const output = projectAuditEvidence(input).batch;
      expect(output.audits.some((audit) => audit.id === 'grader')).toBe(true);
      expect(output.graderObservations?.[0].auditId).toBe('grader');
    }
    const input = batch();
    input.audits.push({ ...input.audits[0], id: 'behavior-again' });
    expect(projectAuditEvidence(input).batch.audits.filter((audit) =>
      audit.type === 'workflow_run_behavior')).toHaveLength(2);
  });

  it('is idempotent and independent of non-conflicting shard order', () => {
    const input = batch();
    const first = projectAuditEvidence(input);
    expect(projectAuditEvidence(first.batch).batch).toEqual(first.batch);
    const reversed = projectAuditEvidence({ ...input, audits: [...input.audits].reverse() });
    expect(reversed.receipt).toEqual(first.receipt);
    expect(reversed.batch.runs).toEqual(first.batch.runs);
    expect(reversed.batch.graderObservations).toEqual(first.batch.graderObservations);
    expect(reversed.batch.audits.map((audit) => audit.id).sort()).toEqual(fixture.residual);
  });

  it('fails before publication for mandatory or live Audit references that cannot resolve', () => {
    const input = batch();
    if (!input.graderObservations?.[0] || !input.graders?.[0]) throw new Error('Expected fixture definitions');
    input.graderObservations[0].auditId = 'not-present';
    expect(() => projectAuditEvidence(input)).toThrow(/auditId/);
    input.graderObservations[0].auditId = 'grader';
    input.graders[0].workflowId = 'another-workflow';
    expect(() => projectAuditEvidence(input)).toThrow(/different workflow/);
  });

  it('does not perform row curation while maintaining a newly initialized database', async () => {
    const indexedDB = new IDBFactory();
    const incoming = batch();
    await upsertCanonicalBatch(indexedDB, incoming);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const result = await maintainCanonicalDatabase(indexedDB, { now: NOW, maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
    expect(result.prunedAudits).toBe(0);
    expect(getAll).not.toHaveBeenCalled();
    getAll.mockRestore();
    expect((await readCollection(indexedDB, 'audits')).map((audit) => audit.id).sort()).toEqual(
      incoming.audits.map((audit) => audit.id).sort()
    );
  });

  it('exposes extracted fields through production canonical queries', async () => {
    const indexedDB = new IDBFactory();
    await upsertCanonicalBatch(indexedDB, projectAuditEvidence(batch()).batch);
    const sources = await queryDatabaseSources(indexedDB, {},
      ['runs', 'grader-observations', 'audit-result-details']);
    expect(sources.runs.rows[0]['session-label']).toBe('Pi/copilot/gpt-5.4');
    expect(sources['grader-observations'].rows[0]).toMatchObject({
      unit: 'historical-unit', direction: null, error: 'Missing runtime helper',
      'current-definition-unit': 'new-unit'
    });
  });

  it('validates fresh transport counts and rejects unprojected old headers', async () => {
    const indexedDB = new IDBFactory();
    const output = projectAuditEvidence(batch());
    const records = Object.entries(output.batch).flatMap(([collection, rows]) =>
      rows.map((record) => ({ kind: 'record', collection, record })));
    const header = { kind: 'metadata', schemaVersion: 29, ingestionVersion: 5,
      phase: 'all', records: records.length, projection: output.receipt };
    const stream = (/** @type {Record<string, unknown>} */ metadata) => (async function* () {
      yield [metadata, ...records].map((entry) => JSON.stringify(entry)).join('\n');
    })();
    await expect(ingestNormalizedJsonl(indexedDB, stream(header), {
      now: NOW, payloadIdentity: 'new', payloadScope: 'new', maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    })).resolves.toMatchObject({ committedRecords: records.length });
    const sources = await queryDatabaseSources(indexedDB, {}, ['runs']);
    expect(sources.runs.metadata['as-of']).toBe(output.receipt.sourceClock);
    await expect(ingestNormalizedJsonl(new IDBFactory(), stream({ ...header, records: records.length + 1 }), {
      now: NOW, payloadIdentity: 'bad-count', payloadScope: 'new', maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    })).rejects.toThrow(/declared/);
    await expect(ingestNormalizedJsonl(new IDBFactory(), stream({ ...header, schemaVersion: 28 }), {
      payloadIdentity: 'old', payloadScope: 'old'
    })).rejects.toThrow(/Unsupported normalized/);
    expect(AUDIT_PROJECTION_VERSION).toBe(1);
  });
});
