// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderLocalDatabaseView } from '../../src/components/local-database-view.js';

const metadata = {
  'source-id': 'database-count-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-16T00:00:00Z',
  'retrieved-at': '2026-09-16T00:00:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
};

describe('Local database view', () => {
  it('renders database counters and local data controls', () => {
    const rendered = renderLocalDatabaseView(/** @type {import('../../src/components/ui-elements.js').ElementRenderContext} */ ({
      pageId: 'transactions',
      title: 'Local database',
      sourceNames: [
        'database-campaign-count',
        'database-repository-count',
        'database-workflow-count',
        'database-run-count',
        'database-domain-count',
        'database-tool-count',
        'database-audit-count',
        'database-issue-count'
      ],
      sources: {
        'database-campaign-count': { source: 'database-campaign-count', rows: [{ campaigns: 2 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 3 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 5 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 8 }], metadata },
        'database-domain-count': { source: 'database-domain-count', rows: [{ domains: 7 }], metadata },
        'database-tool-count': { source: 'database-tool-count', rows: [{ tools: 11 }], metadata },
        'database-audit-count': { source: 'database-audit-count', rows: [{ audits: 13 }], metadata },
        'database-issue-count': { source: 'database-issue-count', rows: [{ issues: 17 }], metadata }
      },
      contextDetails: [],
      headingTag: 'h3'
    }));

    expect(rendered.querySelector('.configuration-database-counts')?.textContent).toContain('13Audits');
    expect(rendered.querySelector('.configuration-database-counts')?.textContent).toContain('17Issues');
    expect(rendered.querySelector('.reset-dashboard-trigger')).not.toBeNull();
  });
});
