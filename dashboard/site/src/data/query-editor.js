import { createDebug } from '../debug.js';
import { validateDashboardDocument } from '../validator.js';
import { dashboardViewSourceNames } from '../view-filter-contract.js';

export const MAX_QUERY_EDITOR_DOCUMENT_CHARACTERS = 131072;

const debugQueryEditor = createDebug('data:query-editor');

/**
 * @typedef {{ ok: true, document: import('../presenter.js').PresentationDocument, pageId: string, sourceNames: string[], errors: [] } | { ok: false, errors: import('../validator.js').ValidationError[] }} QueryEditorValidation
 */

/**
 * Authoring documents are data-only, isolated pages, not new capabilities.
 * @param {unknown} source
 * @returns {QueryEditorValidation}
 */
export function validateQueryEditorDocument(source) {
  const invalid = (/** @type {string} */ message, /** @type {string} */ path = '$') => ({
    ok: /** @type {false} */ (false),
    errors: [{ code: 'QUERY-EDITOR', message, path }]
  });
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_QUERY_EDITOR_DOCUMENT_CHARACTERS) {
    debugQueryEditor({ operation: 'validate-document', status: 'rejected', reason: 'bounds' });
    return invalid('Provide a Dashboard Language document of at most 131072 characters.');
  }
  const result = validateDashboardDocument(source);
  if (!result.ok) {
    debugQueryEditor({ operation: 'validate-document', status: 'rejected', reason: 'schema', errorCount: result.errors.length });
    return result;
  }
  const document = /** @type {import('../presenter.js').PresentationDocument} */ (result.value);
  const dashboard = document.dashboard;
  if (dashboard.pages.length !== 1 || dashboard.pages[0].kind !== 'custom') {
    return invalid('The query editor requires exactly one custom page.', '$.dashboard.pages');
  }
  if (dashboard['cli-actions'] || dashboard.views || dashboard.callouts || dashboard.navigation || dashboard['data-status']) {
    return invalid('Preview documents cannot declare actions, reusable views, callouts, navigation, or data status.', '$.dashboard');
  }
  if (dashboard['card-templates']?.some((card) => 'actions' in card || 'drill' in card)) {
    return invalid('Preview card templates cannot declare actions or drill navigation.', '$.dashboard.card-templates');
  }
  const page = dashboard.pages[0];
  if (page.id !== 'query-preview' || page.route || page.form || page['pull-refresh'] || page['retain-on-navigation']) {
    return invalid('Use the isolated query-preview page without routing, refresh, or retention controls.', '$.dashboard.pages[0]');
  }
  for (const [index, candidate] of page.views.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return invalid('Preview views must be mappings.');
    }
    const view = /** @type {Record<string, unknown>} */ (candidate);
    if (!['metric', 'table', 'chart', 'list'].includes(String(view.mark)) || view.element || view.requires) {
      return invalid('Preview views support only data marks: metric, table, chart, and list.', `$.dashboard.pages[0].views[${index}]`);
    }
    if (view.encoding && typeof view.encoding === 'object' && 'actions' in view.encoding) {
      return invalid('Preview views cannot declare actions.', `$.dashboard.pages[0].views[${index}].encoding.actions`);
    }
    const list = view.list && typeof view.list === 'object' ? /** @type {Record<string, unknown>} */ (view.list) : null;
    if (view['lazy-list'] || view['card-drill'] || list?.action || list?.drill || list?.['view-all']) {
      return invalid('Preview lists and tables cannot declare actions, drill navigation, or lazy pagination.',
        `$.dashboard.pages[0].views[${index}]`);
    }
    const data = /** @type {Record<string, unknown>} */ (view.data);
    const maximumRows = view.layer ? 200 : data.limit;
    if (typeof maximumRows !== 'number' || maximumRows > 200) {
      return invalid('Each preview view must declare data.limit of at most 200 rows.', `$.dashboard.pages[0].views[${index}].data.limit`);
    }
    for (const name of dashboardViewSourceNames(candidate)) {
      const query = dashboard.queries?.find((query) => query.name === name);
      if (!query || !Number.isSafeInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > maximumRows) {
        return invalid('Every preview source must be a declared query with query.limit from 1 through data.limit (at most 200).',
          `$.dashboard.pages[0].views[${index}].data`);
      }
    }
  }
  const sourceNames = [...new Set(page.views.flatMap(dashboardViewSourceNames))];
  debugQueryEditor({ operation: 'validate-document', status: 'accepted', viewCount: page.views.length, sourceCount: sourceNames.length });
  return {
    ok: true,
    document,
    pageId: page.id,
    sourceNames,
    errors: []
  };
}
