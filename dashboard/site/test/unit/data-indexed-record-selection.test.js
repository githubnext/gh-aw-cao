// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import { aggregateToolEvents } from '../../src/data/model/tool-usage.js';
import { upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';
import { createSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';
import { loadDatabaseQuerySources } from '../../src/data/queries/database.js';
import { DASHBOARD_QUERY_LIMITS } from '../../src/data/queries/declarative.js';

const at = '2026-10-03T14:00:00.000Z';
const directories = /** @type {string[]} */ ([]);
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** @param {string} backend */
function factory(backend) {
  if (backend === 'IndexedDB') return new IDBFactory();
  const directory = mkdtempSync(join(tmpdir(), 'cao-tool-selection-'));
  directories.push(directory);
  return createSqliteIndexedDB(join(directory, 'data.sqlite'));
}

function batch() {
  const value = normalize([]);
  value.repositories.push({ id: 'repository:1' });
  value.workflows.push({ id: 'workflow:1', repositoryId: 'repository:1' });
  value.runs.push(...['42', '99'].map(githubRunId => ({
    id: `run:${githubRunId}`, githubRunId, repositoryId: 'repository:1', workflowId: 'workflow:1',
    owner: 'org', repository: 'repo', workflowPath: 'workflow.md', attempt: 1, observedAt: at
  })));
  const events = ['42', '99'].flatMap(run => Array.from({ length: run === '42' ? 2 : 20 }, (_, index) => [
    { id: `call:${run}:${index}`, runId: `run:${run}`, correlationId: `${run}:${index}`, source: 'mcp',
      type: 'tool.call', status: 'started', name: `tool-${index}`, mcpServer: 'opaque/server',
      mcpTool: `tool-${index}`, timestamp: at, observedAt: at, requestBytes: 7 },
    { id: `result:${run}:${index}`, runId: `run:${run}`, correlationId: `${run}:${index}`, source: 'mcp',
      type: 'tool.error', status: 'incomplete', name: `tool-${index}`, mcpServer: 'opaque/server',
      mcpTool: `tool-${index}`, timestamp: at, observedAt: at, requestBytes: 7 }
  ]).flat());
  Object.assign(value, aggregateToolEvents(events));
  for (const run of value.runs) run.toolUsageRevision = value.tools.find(tool => tool.runId === run.id)?.evidenceRevision;
  return value;
}

describe.each(['IndexedDB', 'SQLite'])('compact Tool selection through %s', backend => {
  it('scopes Run/tool counters before applying the input-row budget and preserves opaque identity', async () => {
    const indexedDB = factory(backend);
    await upsertCanonicalBatch(indexedDB, batch());
    const previous = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 3;
    try {
      const queries = [{
        name: 'selected', from: 'mcp-calls',
        filter: { predicates: [{ field: 'run', equals: '42' }] },
        select: [{ field: 'mcp-server' }, { field: 'mcp-tool' }, { field: 'call-count' }, { field: 'request-bytes' }],
        'order-by': [{ field: 'mcp-tool', direction: 'asc' }]
      }];
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
        await loadDatabaseQuerySources(indexedDB, {}, { queries, sourceNames: ['selected'] }));
      expect(result.selected.rows).toEqual([
        { 'mcp-server': 'opaque/server', 'mcp-tool': 'tool-0', 'call-count': 1, 'request-bytes': 7 },
        { 'mcp-server': 'opaque/server', 'mcp-tool': 'tool-1', 'call-count': 1, 'request-bytes': 7 }
      ]);
      expect(result.selected.metadata.availability).toBe('available');
    } finally {
      DASHBOARD_QUERY_LIMITS['max-input-rows'] = previous;
    }
  });

  it('does not count superseded counters after the owning Run evidence revision changes', async () => {
    const indexedDB = factory(backend);
    const value = batch();
    await upsertCanonicalBatch(indexedDB, value);
    const run = value.runs.find(run => run.id === 'run:42');
    if (!run) throw new Error('Missing fixture Run');
    run.toolUsageRevision = 'replacement-without-tool-events';
    await upsertCanonicalBatch(indexedDB, { ...normalize([]), ...value }, { validateRelationships: false });
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(indexedDB, {}, {
      queries: [{ name: 'selected', from: 'mcp-calls', filter: { predicates: [{ field: 'run', equals: '42' }] } }],
      sourceNames: ['selected']
    }));
    expect(result.selected.rows).toEqual([]);
    expect(result.selected.metadata.availability).not.toBe('unavailable');
  });

  it('rejects a scoped selection that exceeds the bounded raw-fact budget', async () => {
    const indexedDB = factory(backend);
    await upsertCanonicalBatch(indexedDB, batch());
    const previous = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 1;
    try {
      await expect(loadDatabaseQuerySources(indexedDB, {}, {
        queries: [{ name: 'selected', from: 'tools', filter: { predicates: [{ field: 'run', equals: '42' }] } }],
        sourceNames: ['selected']
      })).rejects.toThrow(/max-input-rows/);
    } finally {
      DASHBOARD_QUERY_LIMITS['max-input-rows'] = previous;
    }
  });
});
