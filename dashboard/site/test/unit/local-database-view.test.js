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
        'database-package-count',
        'database-repository-count',
        'database-workflow-count',
        'database-run-count',
        'database-event-count'
      ],
      sources: {
        'database-package-count': { source: 'database-package-count', rows: [{ packages: 2 }], metadata },
        'database-repository-count': { source: 'database-repository-count', rows: [{ repositories: 3 }], metadata },
        'database-workflow-count': { source: 'database-workflow-count', rows: [{ workflows: 5 }], metadata },
        'database-run-count': { source: 'database-run-count', rows: [{ runs: 8 }], metadata },
        'database-event-count': { source: 'database-event-count', rows: [{ events: 13 }], metadata }
      },
      contextDetails: [],
      headingTag: 'h3'
    }));

    expect(rendered.querySelector('.configuration-database-counts')?.textContent).toContain('13Events');
    expect(rendered.querySelector('.reset-dashboard-trigger')).not.toBeNull();
  });
});
