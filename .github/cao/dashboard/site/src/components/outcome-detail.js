/**
 * Route-aware safe-output outcome detail.
 */

import { h } from '../dom.js';
import { resolveTitleLink } from './link-content.js';
import { renderOutcomeDetailSection } from './outcome-detail-sections.js';
import { createRouteView } from './route-empty-state.js';
import { rowsFor } from './source-rows.js';
import { text, titleCase } from './count-formatters.js';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderOutcomeDetail(context) {
  const outcomes = rowsFor(context.sources, 'outcomes');
  const root = createRouteView({
    rootClassName: 'outcome-detail',
    routeParameter: context.routeParameter,
    datasetKey: 'outcome',
    selectMessage: 'Select an outcome to view its details.',
    notFoundMessage: 'Outcome not found.',
    renderMatched: (routeValue) => {
      const outcomeId = routeValue.trim();
      const outcome = outcomes.find((row) => String(row['safe-output']) === outcomeId);
      if (!outcome) {
        return null;
      }
      root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
        bubbles: true,
        detail: {
          title: text(outcome['outcome-title']) || outcomeId,
          description: outcomeDescription(outcome),
          titleLink: resolveTitleLink(outcome, context.titleLink)
        }
      }));
      return renderOutcome(outcome);
    }
  });
  return root;
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
