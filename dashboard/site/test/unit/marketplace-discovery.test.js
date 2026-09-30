import { describe, expect, it } from 'vitest';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { renderMarketplaceControls } from '../../src/components/marketplace-controls.js';
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
    'package-name': 'Audit Helper', 'package-description': 'Audit quality checks',
    'verification-status': 'verified', 'maintenance-status': 'active',
    'installation-status': 'installed', 'adoption-count': 1, stars: 2 },
  { id: 'two', 'registry-id': 'other', 'registry-name': 'Other', publisher: 'Beta',
    'package-name': 'Audit Runner', 'package-description': 'Audit security',
    'verification-status': 'unverified', 'maintenance-status': 'unknown',
    'installation-status': 'unknown', 'adoption-count': null, stars: null },
  { id: 'three', 'registry-id': 'primary', 'registry-name': 'Primary', publisher: 'Alpha',
    'package-name': 'Workflow Manager', 'package-description': 'Manage deployments',
    'verification-status': 'verified', 'maintenance-status': 'stale',
    'installation-status': 'not-installed', 'adoption-count': 0, stars: 11 }
];
const sources = { 'marketplace-packages': { source: 'marketplace-packages', rows: packages, metadata } };

function resolve(context = {}) {
  const compiled = compileDashboardViewPayloadQueries(page, 'marketplace', {
    queries: dashboard.queries, queryContext: context
  });
  const result = executeDashboardQueries(compiled.queries, sources);
  /** @param {string} source */
  const rows = (source) => result[compiled.aliases.find((name) => name.includes(`:${source}`)) ?? '']?.rows;
  return { rows, compiled };
}

describe('marketplace discovery', () => {
  it('resolves independent facet sources and ranks known evidence without inventing unknown values', () => {
    const { rows } = resolve();
    expect(rows('marketplace-ranked')?.map((row) => row.id)).toEqual(['one', 'three', 'two']);
    expect(rows('marketplace-registry-options')?.map((row) => row['registry-id'])).toEqual(['other', 'primary']);
    expect(rows('marketplace-ranked')?.[2].stars).toBeNull();
  });

  it('filters and searches only packages while keeping facet options available', () => {
    const { rows } = resolve({
      filters: { 'registry-id': ['primary'], 'maintenance-status': ['active'] },
      search: { fields: ['package-name', 'package-description'], query: 'audit' }
    });
    expect(rows('marketplace-ranked')?.map((row) => row.id)).toEqual(['one']);
    expect(rows('marketplace-registry-options')).toHaveLength(2);
    expect(rows('marketplace-publisher-options')).toHaveLength(2);
  });

  it('sorts by a selected worker field with deterministic ties', () => {
    const { rows } = resolve({ orderBy: [
      { field: 'stars-evidence-rank', direction: 'desc' },
      { field: 'stars', direction: 'desc' },
      { field: 'package-name', direction: 'asc' },
      { field: 'id', direction: 'asc' }
    ] });
    expect(rows('marketplace-ranked')?.map((row) => row.id)).toEqual(['three', 'one', 'two']);
  });

  it('emits query parameters rather than filtering or ranking rows on the main thread', () => {
    const root = renderMarketplaceControls({
      pageId: 'marketplace', title: 'Find packages',
      headingTag: 'h3', sourceNames: ['registries', 'publishers'],
      sources: {
        registries: { source: 'registries', rows: [{ 'registry-id': 'primary', 'registry-name': 'Primary' }], metadata },
        publishers: { source: 'publishers', rows: [{ publisher: 'Alpha' }], metadata }
      },
      contextDetails: []
    });
    /** @type {Array<Record<string, any>>} */
    const received = [];
    root.addEventListener('dashboard-query-context-change', (event) => {
      if (event instanceof CustomEvent) received.push(event.detail.queryContext);
    });
    const registry = /** @type {HTMLSelectElement} */ (root.querySelector('select[name="registry-id"]'));
    registry.value = 'primary';
    registry.dispatchEvent(new Event('change', { bubbles: true }));
    expect(received.at(-1)?.filters).toEqual({ 'registry-id': ['primary'] });
    expect(received.at(-1)?.orderBy.at(-1)).toEqual({ field: 'id', direction: 'asc' });
    /** @type {HTMLInputElement} */ (root.querySelector('input[type="search"]')).value = 'audit';
    root.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(received.at(-1)?.search).toEqual({ fields: ['package-name', 'package-description'], query: 'audit' });
  });
});
// @vitest-environment jsdom
