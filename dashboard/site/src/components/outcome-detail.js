/**
 * Route-aware safe-output outcome detail.
 */

import { h } from '../dom.js';
import { resolveTitleLink } from './link-content.js';
import { renderOutcomeDetailSection } from './outcome-detail-sections.js';
import { renderRouteDetailView } from './route-detail-view.js';
import { rowsFor } from './source-rows.js';
import { text, titleCase } from './count-formatters.js';
import { createDebug } from '../debug.js';

const debugOutcomeDetailAllocation = createDebug('outcome-detail:allocation');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderOutcomeDetail(context) {
  const outcomes = rowsFor(context.sources, 'outcomes');
  return renderRouteDetailView(context, {
    category: 'outcome-detail',
    rootClassName: 'outcome-detail',
    datasetKey: 'outcome',
    selectMessage: 'Select an outcome to view its details.',
    notFoundMessage: 'Outcome not found.',
    rows: outcomes,
    match: (rows, routeValue) => rows.find((row) => String(row['safe-output']) === routeValue.trim()),
    allocation: (outcome, routeValue) => {
      const title = text(outcome['outcome-title']);
      const titleLink = resolveTitleLink(outcome, context.titleLink);
      debugOutcomeDetailAllocation({
        event: 'allocated',
        usedTitleFallback: title.length === 0,
        hasTitleLink: titleLink !== null
      });
      return {
        title: title || routeValue.trim(),
        description: outcomeDescription(outcome),
        titleLink
      };
    },
    renderContent: (outcome) => renderOutcome(outcome)
  });
}

/**
 * @param {Record<string, unknown>} outcome
 * @returns {HTMLElement}
 */
function renderOutcome(outcome) {
  return h(
    'div',
    { className: 'outcome-view' },
    ...['discussion', 'metadata']
      .map((body) => renderOutcomeDetailSection(outcome, body))
      .filter((section) => section !== null)
  );
}

/** @param {Record<string, unknown>} outcome */
function outcomeDescription(outcome) {
  return [
    text(outcome['workflow-name']) || text(outcome.workflow),
    titleCase(text(outcome['outcome-category'])),
    titleCase(text(outcome['outcome-status']) || text(outcome['outcome-state']))
  ].filter(Boolean).join(' · ');
}
