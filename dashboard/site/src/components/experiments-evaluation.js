import { h } from '../dom.js';
import { renderExperimentDetailView } from './experiment-detail-view.js';
import { renderExperimentSummaryView } from './experiment-summary-view.js';
import { renderExperimentTableView } from './experiment-table-view.js';
import { experimentsViewComposition } from './experiments-view-composition.js';
import { renderExperimentsViewShell } from './experiments-view-shell.js';

/** @typedef {Record<string, any>} Row */
/** @typedef {{ experiments: Row[], assignments: Row[], graders: Row[], evals: Row[], runById: Map<string, Row>, graderById: Map<string, Row>, evalById: Map<string, Row> }} ExperimentModel */
/** @typedef {Record<string, string>} ExperimentFilters */

/**
 * Renders the experiment decision surface from experiment, assignment, grader,
 * eval, and run grains without treating workflow completion as experiment success.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderExperimentsEvaluation(context) {
  return renderExperimentsViewShell(context, experimentsViewComposition(context.elementConfig), {
    renderOverview: renderExperimentSummaryView,
    renderTable: renderExperimentTableView,
    renderDetail: renderExperimentDetailView,
    renderNoMatches: () => h('div', { className: 'experiment-empty', role: 'status' }, h('strong', null, 'No experiments match the selected filters.'), h('p', null, 'Clear one or more filters to restore the decision view.'))
  });
}
