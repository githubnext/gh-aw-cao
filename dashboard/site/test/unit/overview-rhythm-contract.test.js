import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/overview-rhythm-contract.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page);
const payload = compileDashboardViewPayloadQueries(page, contract.page, {
  viewId: contract.view,
  sourceNames: [contract.source],
  queries: dashboard.queries,
  queryContext: { timeWindow: contract.time }
});
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'overview-rhythm-contract',
  'source-kind': 'fixture',
  'as-of': contract.time.end,
  'retrieved-at': contract.time.end,
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

/** @param {import('../../src/presenter.js').LogicalSourceInput} [source] */
function execute(source) {
  const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries: payload.queries,
    sourceNames: payload.aliases,
    sources: source ? { 'overview-runs': source } : {}
  }));
  return results[payload.aliases[0]];
}

describe('Overview rhythm query contract', () => {
  it('counts all conclusions and in-flight runs in both weeks through the worker view-payload boundary', () => {
    expect(page.views.find((/** @type {{ id: string }} */ view) => view.id === contract.view).data.sources)
      .toContain(contract.source);
    const result = execute({ source: 'overview-runs', rows: contract.runs, metadata });
    expect(result.metadata.availability).toBe('available');
    expect(result.rows).toEqual([{ rhythm: { days: contract.days } }]);
  });

  it('keeps an empty week distinct from unavailable evidence', () => {
    const result = execute({ source: 'overview-runs', rows: [], metadata: { ...metadata, availability: 'empty' } });
    expect(result.rows).toEqual([{ rhythm: null }]);
    /** @type {Array<import('../../src/presenter.js').LogicalSourceInput | undefined>} */
    const unavailableSources = [
      undefined,
      { source: 'overview-runs', rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    ];
    for (const unavailable of unavailableSources) {
      const missing = execute(unavailable);
      expect(missing.metadata.availability).toBe('unavailable');
      expect(missing.rows).toEqual([]);
    }
  });
});
