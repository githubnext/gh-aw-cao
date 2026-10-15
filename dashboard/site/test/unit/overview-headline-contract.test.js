import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/overview-headline-contract.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page);
const view = page.views.find((/** @type {{ id: string }} */ view) => view.id === contract.view);
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'overview-headline-contract',
  'source-kind': 'fixture',
  'as-of': '2026-10-15T00:00:00Z',
  'retrieved-at': '2026-10-15T00:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

/** @param {string} name @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} sources */
function execute(name, sources) {
  const payload = compileDashboardViewPayloadQueries(page, contract.page, {
    viewId: contract.view, sourceNames: [name], queries: dashboard.queries
  });
  const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: payload.queries, sourceNames: payload.aliases, sources
  }));
  expect(payload.aliases).toHaveLength(1);
  return results[payload.aliases[0]];
}

const sources = Object.fromEntries(Object.entries(contract.inputs).map(([source, rows]) => [
  source, { source, rows, metadata }
]));

describe('Overview headline query contract', () => {
  it('declares all four independently bound stations', () => {
    expect(view.data.sources).toEqual(contract.sources);
    expect(view.config.stations).toEqual(contract.stations);
  });

  it.each(Object.entries(contract.expected))('produces bounded %s through the worker view-payload boundary', (name, expected) => {
    const result = execute(name, sources);
    expect(result.metadata.availability).toBe('available');
    expect(result.rows).toEqual([expected]);
    const empty = execute(name, Object.fromEntries(Object.entries(sources).map(([name, source]) => [
      name, { ...source, rows: [], metadata: { ...metadata, availability: 'empty' } }
    ])));
    expect(empty.rows).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it.each([
    ['overview-issue-station', 'issues'],
    ['overview-value-station', 'grader-observations']
  ])('fails closed for unavailable %s evidence', (name, input) => {
    const result = execute(name, {
      ...sources,
      [input]: { source: input, rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.rows).toEqual([]);
    expect(execute(name, {}).metadata.availability).toBe('unavailable');
  });
});
