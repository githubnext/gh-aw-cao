import { processDashboardQueries } from '../../../src/data-processor.js';
import { compileDashboardViewPayloadQueries } from '../../../src/data/queries/view-payload-compiler.js';

/**
 * @param {import('../../../src/presenter.js').PresentationDocument & {
 *   dashboard: import('../../../src/presenter.js').PresentationDocument['dashboard'] & {
 *     queries?: Array<Record<string, unknown>>
 *   }
 * }} document
 * @param {string} pageId
 * @param {Record<string, import('../../../src/presenter.js').LogicalSourceInput>} sources
 * @param {{ routeParameters?: Record<string, string>, queryContext?: import('../../../src/presenter.js').PageSourceLoadOptions['queryContext'] }} [options]
 */
export async function prepareDashboardViewSources(document, pageId, sources, options = {}) {
  const queries = document.dashboard.queries ?? [];
  const page = document.dashboard.pages.find((candidate) => candidate.id === pageId);
  const querySources = queries.length > 0
    ? await processDashboardQueries(queries, sources)
    : {};
  if (!page) return { ...sources, ...querySources };
  const payload = compileDashboardViewPayloadQueries(page, pageId, {
    ...options,
    queries
  });
  const aliases = payload.queries.length > 0
    ? await processDashboardQueries(
        payload.queries,
        { ...sources, ...querySources },
        { sourceNames: payload.aliases }
      )
    : {};
  return { ...sources, ...querySources, ...aliases };
}
