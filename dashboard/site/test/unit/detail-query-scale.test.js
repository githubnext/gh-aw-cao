import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DASHBOARD_QUERY_LIMITS } from '../../src/data/queries/declarative.js';
import {
  DATABASE_NAME,
  ENTITY_STORES,
  upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/detail-query-contracts.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
const selectedCalls = 2050;
const largeScope = DASHBOARD_QUERY_LIMITS['max-output-rows'] + 5;
const observedAt = '2026-10-02T00:00:00Z';
const metadata = {
  'source-id': 'detail-scale',
  'source-kind': 'fixture',
  'as-of': observedAt,
  'retrieved-at': observedAt,
  'artifact-generation': 'detail-scale',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};
const sourceMetadata = Object.fromEntries(['runs', 'audits', 'domains', 'tools', 'issues', 'mcp-calls'].map((source) => [
  source, { source, rows: [], metadata }
]));

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
}

beforeAll(async () => {
  await deleteDatabase();
  const runs = [1, 2, 3].map((attempt) => ({
    id: `canonical-run-${attempt}`,
    owner: contract.run.organization,
    repository: contract.run.repository,
    workflowPath: contract.run.workflow,
    githubRunId: attempt === 3 ? '99' : contract.run.run,
    attempt: attempt === 3 ? 1 : attempt,
    observedAt,
    runLink: {
      relation: 'run',
      href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${attempt === 3 ? '99' : contract.run.run}/attempts/${attempt === 3 ? 1 : attempt}`
    }
  }));
  /** @type {Record<string, unknown>[]} */
  const tools = Array.from({ length: largeScope }, (_, index) => ({
    id: `bulk-tool-${index}`,
    runId: runs[2].id,
    source: 'mcp',
    type: 'tool.call',
    mcpServer: 'bulk',
    mcpTool: 'large-tool',
    status: 'success',
    timestamp: observedAt,
    observedAt
  }));
  tools.push(...Array.from({ length: selectedCalls }, (_, index) => ({
    id: `selected-tool-${index}`,
    runId: runs[index % 2].id,
    source: 'mcp',
    type: 'tool.call',
    mcpServer: 'github',
    mcpTool: 'issue_read',
    status: index % 5 === 0 ? 'failure' : 'success',
    timestamp: observedAt,
    observedAt
  })));
  tools.push(...[
    { id: 'safe-output-tool', mcpServer: 'safeoutputs', mcpTool: 'optimization_skills_curator' },
    { id: 'ambiguous-one', mcpServer: 'server/with', mcpTool: 'slash/tool' },
    { id: 'ambiguous-two', mcpServer: 'server', mcpTool: 'with/slash/tool' },
    { id: 'missing-server', mcpTool: 'missing-server' },
    { id: 'null-server', mcpServer: null, mcpTool: 'missing-server' },
    { id: 'missing-tool', mcpServer: 'missing-tool' }
  ].map((tool) => ({
    ...tool, runId: runs[0].id, source: 'mcp', type: 'tool.call', status: 'success', timestamp: observedAt, observedAt
  })));
  const audits = Array.from({ length: largeScope }, (_, index) => ({
    id: `bulk-audit-${index}`,
    runId: runs[2].id,
    source: 'agent',
    type: 'agent.turn',
    timestamp: observedAt,
    observedAt
  }));
  audits.push({ id: 'selected-audit', runId: runs[0].id, source: 'agent', type: 'agent.turn', timestamp: observedAt, observedAt });
  const batch = /** @type {import('../../src/data/model/schema.js').CanonicalBatch} */ (/** @type {unknown} */ (
    Object.fromEntries(ENTITY_STORES.map((store) => [store, []]))
  ));
  Object.assign(batch, {
    runs,
    tools,
    audits,
    domains: [{ id: 'selected-domain', runId: runs[0].id, domain: 'github.com', timestamp: observedAt, observedAt }],
    issues: [{ id: 'selected-issue', runId: runs[0].id, number: 123, timestamp: observedAt, observedAt }]
  });
  await upsertCanonicalBatch(indexedDB, batch, { validateRelationships: false });
}, 120000);

afterAll(deleteDatabase);

/**
 * @param {string} pageId
 * @param {string} viewId
 * @param {Record<string, string>} routeParameters
 * @param {{ limit: number, continuationToken?: string }} [pagination]
 * @param {typeof sourceMetadata} [sources]
 */
async function load(pageId, viewId, routeParameters, pagination, sources = sourceMetadata) {
  const payload = compileDashboardViewPayloadQueries(
    dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === pageId),
    pageId,
    { viewId, routeParameters, queries: dashboard.queries, views: dashboard.views }
  );
  const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources',
    queries: payload.queries,
    sourceNames: payload.aliases,
    sources,
    pagination: pagination ? { [payload.aliases[0]]: pagination } : undefined
  }));
  return results[payload.aliases[0]];
}

describe('canonical worker selected detail scale', () => {
  it('scopes four event inputs before a combined union exceeding 200,000 records', async () => {
    const result = await load('run-events', 'run-events', contract.run);
    expect(result.metadata.availability).toBe('available');
    expect(result.rows).toHaveLength(selectedCalls / 2 + 9);
    expect(new Set(result.rows.map((row) => row.event)).size).toBe(result.rows.length);
    expect(result.rows.every((row) => String(row['run-attempt']) === contract.run['run-attempt'])).toBe(true);
    expect(result.rows.map((row) => row.event)).toEqual(expect.arrayContaining([
      'selected-audit', 'selected-domain', 'selected-issue'
    ]));
    const attempt2 = await load('run-events', 'run-events', { ...contract.run, 'run-attempt': '2' });
    expect(attempt2.rows).toHaveLength(selectedCalls / 2);
    expect(attempt2.rows.every((row) => String(row['run-attempt']) === '2')).toBe(true);
  }, 60000);

  it('keeps all selected tool observations and status counts in a fleet over 100,000 calls', async () => {
    const observations = await load('tool-runs', 'tool-runs-table', { tool: contract.tools[0] });
    expect(observations.metadata.availability).toBe('available');
    expect(observations.rows).toHaveLength(selectedCalls);
    expect(new Set(observations.rows.map((row) => row['mcp-observation'])).size).toBe(selectedCalls);
    expect(new Set(observations.rows.map((row) => /** @type {{ href: string }} */ (row['run-link']).href)).size).toBe(2);
    const counts = await load('tool-insights', 'tool-insights-chart', { tool: contract.tools[0] });
    expect(counts.metadata.availability).toBe('available');
    expect(counts.rows).toEqual([
      { 'mcp-tool-label': 'github/issue_read', 'mcp-server': 'github', 'mcp-tool': 'issue_read', 'mcp-status': 'success', observations: 1640 },
      { 'mcp-tool-label': 'github/issue_read', 'mcp-server': 'github', 'mcp-tool': 'issue_read', 'mcp-status': 'failure', observations: 410 }
    ]);
  }, 60000);

  it('accepts observed safe-output routes and opaque concat labels without splitting their components', async () => {
    for (const [tool, identities] of [
      [contract.tools[1], ['safe-output-tool']],
      [contract.tools[2], ['ambiguous-one', 'ambiguous-two']],
      [contract.tools[3], ['missing-server', 'null-server']],
      [contract.tools[4], ['missing-tool']]
    ]) {
      const result = await load('tool-runs', 'tool-runs-table', { tool: String(tool) });
      expect(result.metadata.availability).toBe('available');
      expect(result.rows.map((row) => row['mcp-observation']).sort()).toEqual(identities);
    }
  }, 60000);

  it('returns honest empty results for unmatched and absent route values without unscoped materialization', async () => {
    for (const route of /** @type {Record<string, string>[]} */ ([{ tool: 'not-observed/tool' }, {}])) {
      const result = await load('tool-runs', 'tool-runs-table', route);
      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('empty');
    }
    for (const route of [{ ...contract.run, run: 'not-observed' }, {}]) {
      const result = await load('run-events', 'run-events', route);
      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('empty');
    }
  }, 60000);

  it('paginates selected observations without duplication and rejects a token after entity navigation', async () => {
    const observed = new Set();
    /** @type {string | undefined} */
    let token;
    do {
      const page = await load('tool-runs', 'tool-runs-table', { tool: contract.tools[0] }, { limit: 700, continuationToken: token });
      for (const row of page.rows) {
        expect(observed.has(row['mcp-observation'])).toBe(false);
        observed.add(row['mcp-observation']);
      }
      token = page.continuationToken;
      if (token) {
        await expect(load('tool-runs', 'tool-runs-table', { tool: contract.tools[1] }, { limit: 700, continuationToken: token }))
          .rejects.toThrow(/stale continuation token/);
      }
    } while (token);
    expect(observed.size).toBe(selectedCalls);
  }, 60000);

  it('fails closed rather than truncating when the selected tool or run itself exceeds budgets', async () => {
    for (const result of [
      await load('tool-runs', 'tool-runs-table', { tool: 'bulk/large-tool' }),
      await load('run-events', 'run-events', { ...contract.run, run: '99' })
    ]) {
      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('unavailable');
      expect(result.metadata['query-diagnostic']).toBeDefined();
    }
  }, 60000);

  it('preserves an unavailable primary source even when the route has no matching observations', async () => {
    const sources = { ...sourceMetadata, audits: { ...sourceMetadata.audits, metadata: { ...metadata, availability: 'unavailable' } } };
    const result = await load('run-events', 'run-events', { ...contract.run, run: 'not-observed' }, undefined, sources);
    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
  }, 60000);
});
