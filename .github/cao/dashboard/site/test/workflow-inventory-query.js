import { readFileSync } from 'node:fs';
import { processDataRequest } from '../src/data-worker.js';

const authoritativeDashboard = JSON.parse(
  readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')
).dashboard;
const authoritativeQueries = authoritativeDashboard.queries;

/**
 * Applies the authoritative declarative queries the way the data worker does, so
 * presentation tests can render derived sources without a main-thread fallback.
 *
 * @param {Record<string, import('../src/presenter.js').LogicalSourceInput>} sources
 * @param {string[]} [requested]
 * @returns {Record<string, import('../src/presenter.js').LogicalSourceInput>}
 */
export function applyDashboardQueries(sources, requested = ['workflow-inventory']) {
  return /** @type {Record<string, import('../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries: authoritativeQueries,
    sources,
    sourceNames: requested,
    context: {
      githubUrlBase: authoritativeDashboard['github-url-base'],
      pages: authoritativeDashboard.pages,
      queries: authoritativeQueries
    }
  }));
}
