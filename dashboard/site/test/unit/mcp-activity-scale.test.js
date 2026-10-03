import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { DASHBOARD_QUERY_LIMITS } from '../../src/data/queries/declarative.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

describe('bounded MCP activity inventory', () => {
  it('counts more than 100,000 calls through the production query handler without an oversized label-only intermediate', async () => {
    const count = DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1;
    const rows = Array.from({ length: count }, (_, index) => ({
      organization: 'githubnext', repository: 'gh-aw-cao',
      workflow: `workflow-${index % 3}.md`, 'mcp-observation': `call-${index}`,
      'mcp-server': 'github', 'mcp-tool': 'list_issues',
      'request-bytes': 2, 'response-bytes': 3
    }));
    rows.push({
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'workflow-0.md',
      'mcp-observation': 'safe-output-call', 'mcp-server': 'safe_outputs',
      'mcp-tool': 'create_issue', 'request-bytes': 100, 'response-bytes': 200
    });
    const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      await processDataRequest({
        operation: 'execute-dashboard-queries',
        queries: authoritativeDashboard.dashboard.queries,
        sourceNames: ['mcp-tool-workflow-totals', 'mcp-tool-totals', 'mcp-top-tools'],
        sources: {
          'mcp-calls': {
            source: 'mcp-calls', rows,
            metadata: {
              'source-id': 'mcp-calls', 'source-kind': 'database-query',
              'as-of': '2026-10-02T00:00:00Z', 'retrieved-at': '2026-10-02T00:00:00Z',
              availability: 'available', completeness: 'complete', freshness: 'fresh'
            }
          }
        }
      })
    );

    expect(sources['mcp-tool-workflow-totals'].rows).toHaveLength(4);
    expect(sources['mcp-tool-totals'].metadata.availability).toBe('available');
    expect(sources['mcp-tool-totals'].rows).toEqual([{
      'mcp-tool-label': 'github/list_issues', 'mcp-tool': 'list_issues', 'mcp-server': 'github',
      calls: count, workflows: 3, 'request-bytes': count * 2, 'response-bytes': count * 3
    }]);
    expect(sources['mcp-top-tools'].rows).toEqual([{
      'mcp-tool-label': 'github/list_issues', 'mcp-tool': 'list_issues',
      'mcp-server': 'github', calls: count, workflows: 3,
      'request-bytes': count * 2, 'response-bytes': count * 3
    }]);
  }, 10000);
});
