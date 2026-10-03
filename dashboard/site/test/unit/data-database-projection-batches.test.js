import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCollections } from '../../src/data/storage/indexeddb.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { DASHBOARD_QUERY_LIMITS, executeDashboardQueries } from '../../src/data/queries/declarative.js';

vi.mock('../../src/data/storage/indexeddb.js', async (importOriginal) => ({
  ...await importOriginal(),
  readCollections: vi.fn()
}));

const metadata = {
  'as-of': '2026-10-02T00:00:00Z',
  'retrieved-at': '2026-10-02T00:00:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
};
const run = {
  id: 'run:1', owner: 'githubnext', repository: 'gh-aw-cao',
  workflowPath: '.github/workflows/activity.md', githubRunId: '1', attempt: 1
};

/** @param {number} count @param {string} source */
function records(count, source) {
  return Array.from({ length: count }, (_, index) => ({
    id: `record:${index}`, runId: run.id, source,
    type: 'tool.call', mcpTool: 'list_issues', mcpServer: 'github'
  }));
}

afterEach(() => vi.restoreAllMocks());

describe('bounded canonical database projections', () => {
  it('preserves every audit above the view output limit without weakening view query limits', async () => {
    const count = DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1;
    vi.mocked(readCollections).mockResolvedValue({ runs: [run], audits: records(count, 'agent') });

    const projected = await queryDatabaseSources(indexedDB, { audits: { metadata } }, ['audits']);

    expect(projected.audits.metadata.availability).toBe('available');
    expect(projected.audits.rows).toHaveLength(count);
    expect(projected.audits.rows[0]).toMatchObject({ event: 'record:0', run: '1' });
    expect(projected.audits.rows.at(-1)).toMatchObject({ event: `record:${count - 1}`, run: '1' });
    const unboundedView = executeDashboardQueries([{ name: 'all-audits', from: 'audits' }], projected);
    expect(unboundedView['all-audits'].metadata.availability).toBe('unavailable');
    expect(unboundedView['all-audits'].metadata['query-diagnostic']).toContain('max-output-rows');
  }, 10000);

  it('projects and filters MCP calls across the native input limit without losing the last batch', async () => {
    const count = DASHBOARD_QUERY_LIMITS['max-input-rows'] + 1;
    const tools = records(count, 'shell');
    tools[0].source = 'mcp';
    tools[count - 1].source = 'mcp';
    vi.mocked(readCollections).mockResolvedValue({ runs: [run], tools });

    const projected = await queryDatabaseSources(indexedDB, {
      tools: { metadata }, 'mcp-calls': { metadata }
    }, ['tools', 'mcp-calls']);

    expect(projected.tools.metadata.availability).toBe('available');
    expect(projected.tools.rows).toHaveLength(count);
    expect(projected['mcp-calls'].metadata.availability).toBe('available');
    expect(projected['mcp-calls'].rows).toEqual([
      expect.objectContaining({ 'mcp-observation': 'record:0', run: '1' }),
      expect.objectContaining({ 'mcp-observation': `record:${count - 1}`, run: '1' })
    ]);
    const unboundedView = executeDashboardQueries([{
      name: 'all-tools', from: 'tools',
      aggregate: { values: [{ field: 'event', as: 'count', reducer: 'count' }] }
    }], projected);
    expect(unboundedView['all-tools'].metadata.availability).toBe('unavailable');
    expect(unboundedView['all-tools'].metadata['query-diagnostic']).toContain('max-input-rows');
  }, 10000);

  it('fails the entire projection when a join fails instead of returning earlier batches', async () => {
    const count = DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1;
    vi.mocked(readCollections).mockResolvedValue({
      runs: [run, { ...run }], audits: records(count, 'agent')
    });

    const projected = await queryDatabaseSources(indexedDB, { audits: { metadata } }, ['audits']);

    expect(projected.audits.rows).toEqual([]);
    expect(projected.audits.metadata.availability).toBe('unavailable');
    expect(projected.audits.metadata['query-diagnostic']).toContain('more than one row per join key');
  });
});
import 'fake-indexeddb/auto';
