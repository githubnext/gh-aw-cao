import { describe, expect, it } from 'vitest';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const dashboard = authoritativeDashboard.dashboard;
const page = dashboard.pages.find((/** @type {{id: string}} */ candidate) => candidate.id === 'marketplace');
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'marketplace-fixture', 'source-kind': 'fixture',
  'as-of': '2026-09-30T00:00:00Z', 'retrieved-at': '2026-09-30T00:00:00Z',
  completeness: 'complete', freshness: 'fresh', availability: 'available'
};
const packages = [
  { id: 'one', 'registry-id': 'primary', 'registry-name': 'Primary', publisher: 'Alpha',
    'package-name': 'Audit Helper', 'package-description': 'Audit quality checks', stars: 2 },
  { id: 'two', 'registry-id': 'other', 'registry-name': 'Other', publisher: 'Beta',
    'package-name': 'Audit Runner', 'package-description': 'Audit security', stars: null },
  { id: 'three', 'registry-id': 'primary', 'registry-name': 'Primary', publisher: 'Alpha',
    'package-name': 'Workflow Manager', 'package-description': 'Manage deployments', stars: 11 }
];
const sources = { 'marketplace-packages': { source: 'marketplace-packages', rows: packages, metadata } };

function resolve() {
  const compiled = compileDashboardViewPayloadQueries(page, 'marketplace', {
    queries: dashboard.queries
  });
  const baseResults = executeDashboardQueries(dashboard.queries, sources);
  const result = {
    ...baseResults,
    ...(compiled.queries.length > 0 ? executeDashboardQueries(compiled.queries, { ...sources, ...baseResults }) : {})
  };
  /** @param {string} source */
  const rows = (source) => (
    result[compiled.aliases.find((name) => name.includes(`:${source}`)) ?? '']
    ?? result[source]
    ?? sources[source]
  )?.rows;
  return { rows, compiled };
}

describe('marketplace discovery', () => {
  it('binds the declarative card list directly to marketplace packages without facets or ranking', () => {
    expect(page.views).toHaveLength(1);
    expect(page.views[0]).toMatchObject({
      mark: 'list', data: { source: 'marketplace-packages' },
      list: { style: 'entity-cards', card: 'marketplace-package-summary' }
    });
    expect(dashboard.queries.some((query) => query.name.startsWith('marketplace-')
      && query.name !== 'marketplace-package-detail')).toBe(false);
    const { rows } = resolve();
    expect(rows('marketplace-packages')?.map((row) => row.id)).toEqual(['one', 'two', 'three']);
    expect(rows('marketplace-packages')?.[1].stars).toBeNull();
  });
});
