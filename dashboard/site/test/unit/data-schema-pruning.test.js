import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { PRUNED_CANONICAL_FIELDS, pruneCanonicalRecord } from '../../src/data/model/fields.js';
import { normalize } from '../../src/data/normalize/index.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import definitions from '../../src/data/queries/database.json' with { type: 'json' };
import { readCollection, replaceCanonicalBatch, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';
import { createSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';

const directories = /** @type {string[]} */ ([]);
const observedAt = '2026-10-02T00:00:00.000Z';

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function batch() {
  const value = normalize([]);
  value.repositories.push({ id: 'repository:1', owner: 'owner', name: 'repo', observedAt });
  value.workflows.push({
    id: 'workflow:1', repositoryId: 'repository:1', path: '.github/workflows/demo.md',
    observedAt, ghAwMetadata: { raw: 'metadata' }, ghAwManifest: { raw: 'manifest' }
  });
  value.runs.push({
    id: 'github:run:owner/repo:1', githubRunId: '1', attempt: 2, owner: 'owner', repository: 'repo',
    repositoryId: 'repository:1', workflowId: 'workflow:1', observedAt,
    startedAt: observedAt, aicTotal: 2.5, aic: 2.5,
    inputTokens: 100, outputTokens: 20, tokenUsage: { raw: 'usage' },
    graders: { results: [{ id: 'quality', value: 1 }] }, context: { raw: 'context' },
    logsPayload: { raw: 'logs' }, customEvidence: { retained: true }
  });
  value.tools.push({
    id: 'tool:1', runId: value.runs[0].id, timestamp: observedAt, observedAt,
    type: 'tool.call', name: 'search', mcpServer: 'github', mcpTool: 'search',
    toolType: 'mcp', isSkill: false, requestBytes: 42, responseBytes: 0,
    correlationId: 'call-1', provenance: { source: 'gh-aw-logs', sourceId: 'call-1', observedAt }
  });
  value.issues.push({
    id: 'issue:1', runId: value.runs[0].id, timestamp: observedAt, observedAt,
    state: 'closed', closed: true, stateReason: null, issueState: 'closed',
    issueClosed: true, issueStateReason: null, issueClosedAt: null, closedAt: null
  });
  return value;
}

describe('canonical field pruning', () => {
  it('never prunes a field required by a canonical database query', () => {
    const recordStores = ['domains', 'tools', 'skills', 'friction', 'audits', 'issues'];
    for (const definition of definitions) {
      const stores = definition.from === '$records' ? recordStores : [definition.from.slice(1)];
      const derived = new Set([
        ...(definition.joins ?? []).flatMap((join) => join.fields.map((field) => field.as ?? field.field)),
        ...(definition.compute ?? []).map((field) => field.as)
      ]);
      const fields = [
        ...(definition.select ?? []).map((field) => field.field),
        ...(definition.compute ?? []).flatMap((field) => (field.args ?? []).flatMap((arg) => 'field' in arg ? [arg.field] : [])),
        ...(definition.filter?.predicates ?? []).map((field) => field.field),
        ...(definition.joins ?? []).flatMap((join) => join.on.map((key) => key.left))
      ].filter((field) => typeof field === 'string' && !derived.has(field));
      for (const store of stores) {
        for (const field of fields) expect(PRUNED_CANONICAL_FIELDS[store] ?? []).not.toContain(field);
      }
      for (const relation of definition.joins ?? []) {
        for (const field of [...relation.on.map((key) => key.right), ...relation.fields.map((field) => field.field)]) {
          expect(PRUNED_CANONICAL_FIELDS[relation.source.slice(1)] ?? []).not.toContain(field);
        }
      }
    }
  });

  it('is non-mutating and idempotent and preserves unknown evidence, null and provenance', () => {
    const record = batch().runs[0];
    const pruned = pruneCanonicalRecord('runs', record);
    expect(record).toHaveProperty('tokenUsage');
    expect(pruned).not.toHaveProperty('tokenUsage');
    expect(pruned).toMatchObject({ aicTotal: 2.5, attempt: 2, customEvidence: { retained: true } });
    expect(pruneCanonicalRecord('runs', pruned)).toBe(pruned);
    const audit = { id: 'audit:1', tokenUsage: { retained: true }, state: null };
    expect(pruneCanonicalRecord('audits', audit)).toBe(audit);
    expect(pruneCanonicalRecord('issues', batch().issues[0])).toMatchObject({
      state: 'closed', closed: true, stateReason: null, closedAt: null
    });
  });

  it('prunes raw observations during normalization without discarding separate evidence', () => {
    const run = batch().runs[0];
    const value = normalize([
      { kind: 'run', source: 'gh-aw-logs', sourceId: 'run:1', observedAt, data: run },
      { kind: 'grader-observation', source: 'gh-aw-logs', sourceId: 'grade:1', observedAt,
        data: { id: 'grade:1', runId: run.id, graderId: 'grader:quality', value: 1 } }
    ]);
    expect(value.runs[0]).not.toHaveProperty('graders');
    expect(value.runs[0]).toMatchObject({ aicTotal: 2.5, inputTokens: 100, outputTokens: 20 });
    expect(value.graderObservations).toEqual([expect.objectContaining({ value: 1, graderId: 'grader:quality' })]);
    expect(value.runs[0].provenance).toEqual({ source: 'gh-aw-logs', sourceId: 'run:1', observedAt });
  });
});

describe.each(['IndexedDB', 'SQLite'])('pruning at the %s storage boundary', (backend) => {
  it('prunes published records on upsert and replacement while preserving query payloads', async () => {
    let indexedDB = new IDBFactory();
    if (backend === 'SQLite') {
      const directory = mkdtempSync(join(tmpdir(), 'cao-schema-pruning-'));
      directories.push(directory);
      indexedDB = createSqliteIndexedDB(join(directory, 'dashboard.sqlite'));
    }
    const input = batch();
    await upsertCanonicalBatch(indexedDB, input);
    const before = await queryDatabaseSources(indexedDB, {}, ['runs', 'tools', 'issues']);
    for (const store of /** @type {const} */ (['runs', 'workflows', 'tools', 'issues'])) {
      const [record] = await readCollection(indexedDB, store);
      for (const field of PRUNED_CANONICAL_FIELDS[store]) expect(record).not.toHaveProperty(field);
    }
    expect(before.runs.rows[0]).toMatchObject({ 'aic-total': 2.5, 'run-attempt': 2, 'input-tokens': 100 });
    expect(before.tools.rows[0]).toMatchObject({ 'mcp-tool': 'search', 'request-bytes': 42, 'correlation-id': 'call-1' });
    expect(before.tools.rows[0]).not.toHaveProperty('is-skill');
    expect(before.issues.rows[0]).toMatchObject({ 'issue-state': 'closed', 'issue-state-reason': null });
    await replaceCanonicalBatch(indexedDB, input, { previousBatch: input });
    const after = await queryDatabaseSources(indexedDB, {}, ['runs', 'tools', 'issues']);
    expect(after).toEqual(before);
    expect((await readCollection(indexedDB, 'runs'))[0]).not.toHaveProperty('logsPayload');
    expect(input.runs[0]).toHaveProperty('logsPayload');
  });
});
