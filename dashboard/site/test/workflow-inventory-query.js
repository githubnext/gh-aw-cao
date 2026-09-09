import { readFileSync } from 'node:fs';
import { executeDashboardQueries } from '../src/data/queries/declarative.js';

const authoritativeQueries = JSON.parse(
  readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')
).dashboard.queries;

/**
 * Applies the authoritative declarative queries the way the data worker does, so
 * presentation tests can render derived sources without a main-thread fallback.
 *
 * @param {Record<string, import('../src/presenter.js').LogicalSourceInput>} sources
 * @returns {Record<string, import('../src/presenter.js').LogicalSourceInput>}
 */
export function applyDashboardQueries(sources) {
  return { ...sources, ...executeDashboardQueries(authoritativeQueries, sources) };
}
