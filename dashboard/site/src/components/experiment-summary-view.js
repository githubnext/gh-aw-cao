import { h } from '../dom.js';
import { renderDlRow } from './ui-primitives.js';

const UNKNOWN = '—';

/**
 * @param {Array<Record<string, any>>} experiments
 * @returns {HTMLElement}
 */
export function renderExperimentSummaryView(experiments) {
  const active = experiments.filter((experiment) => !['PROMOTE', 'REJECT'].includes(experiment.decision)).length;
  const ready = experiments.filter((experiment) => experiment.readiness === 'READY').length;
  const regressions = experiments.filter((experiment) => experiment.regressingGuardrails.length > 0).length;
  const usable = experiments.reduce((total, experiment) => total + experiment.usable, 0);
  const excluded = experiments.reduce((total, experiment) => total + experiment.excluded, 0);
  const coverage = usable + excluded > 0 ? usable / (usable + excluded) : null;
  const pending = experiments.filter((experiment) => ['READY', 'INCONCLUSIVE', 'EXTEND'].includes(experiment.decision)).length;
  const stateCounts = countBy(experiments, (experiment) => experiment.readiness);
  return h(
    'section',
    { className: 'experiment-overview', 'aria-labelledby': 'experiment-overview-title' },
    h(
      'div',
      { className: 'experiment-readiness-chart', 'data-chart-widget': 'pie' },
      h('div', {
        className: 'experiment-readiness-donut',
        role: 'img',
        'aria-label': [...stateCounts].map(([state, count]) => `${count} ${state.toLowerCase()}`).join(', '),
        style: `--ready:${percentage(stateCounts.get('READY') ?? 0, experiments.length)}deg;--collecting:${percentage((stateCounts.get('READY') ?? 0) + (stateCounts.get('COLLECTING') ?? 0), experiments.length)}deg`
      }, h('span', null, String(experiments.length))),
      h('div', null, h('h2', { id: 'experiment-overview-title' }, 'Decision readiness'), h('p', null, 'Experiment state, never workflow-run success.'), renderLegend(stateCounts))
    ),
    h(
      'dl',
      { className: 'experiment-summary' },
      summaryItem('Active experiments', active),
      summaryItem('Ready for decision', ready),
      summaryItem('Guardrail regressions', regressions),
      summaryItem('Usable observations', coverage === null ? UNKNOWN : `${(coverage * 100).toFixed(1)}%`),
      summaryItem('Decisions pending', pending)
    )
  );
}

/**
 * @param {Map<string, number>} counts
 * @returns {HTMLElement}
 */
function renderLegend(counts) {
  return h('ul', { className: 'experiment-state-legend' }, ...[...counts].map(([state, count]) => h('li', null, h('span', { className: `state-dot state-${state.toLowerCase()}` }), `${state} ${count}`)));
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {HTMLElement}
 */
function summaryItem(label, value) {
  return renderDlRow(label, String(value));
}

/**
 * @param {number} value
 * @param {number} total
 * @returns {number}
 */
function percentage(value, total) {
  return total > 0 ? value / total * 360 : 0;
}

/**
 * @param {any[]} rows
 * @param {(row: any) => string} key
 * @returns {Map<string, number>}
 */
function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
