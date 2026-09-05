import { h } from '../dom.js';
import { renderExperimentBadge } from './badge.js';
import { renderExperimentDetailSection, renderExperimentSectionHeading } from './experiment-detail-sections.js';
import { renderDlRow } from './ui-primitives.js';
import { experimentsViewComposition } from './experiments-view-composition.js';
import { renderExperimentsViewShell } from './experiments-view-shell.js';

const UNKNOWN = '—';
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
  return renderExperimentsViewShell(context, experimentsViewComposition(context.elementConfig?.body), {
    renderOverview: renderDecisionOverview,
    renderTable: renderDecisionTable,
    renderDetail: renderExperimentDetails,
    renderNoMatches: () => h('div', { className: 'experiment-empty', role: 'status' }, h('strong', null, 'No experiments match the selected filters.'), h('p', null, 'Clear one or more filters to restore the decision view.'))
  });
}

/** @param {any[]} experiments @returns {HTMLElement} */
function renderDecisionOverview(experiments) {
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

/** @param {any[]} experiments @param {string} selectedId @param {(id: string) => void} onSelect @returns {HTMLElement} */
function renderDecisionTable(experiments, selectedId, onSelect) {
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'experiment-decisions-title' },
    renderExperimentSectionHeading('experiment-decisions-title', 'Experiment decisions', 'Guardrail failures and decision-ready experiments are shown first.'),
    h(
      'div',
      { className: 'table-region experiment-table-region' },
      h(
        'table',
        { className: 'experiment-decision-table' },
        h('thead', null, h('tr', null, ...['Experiment', 'Workflow / agent', 'Variants', 'Primary metric', 'Usable samples', 'Effect', 'Evidence', 'Guardrails', 'Readiness', 'Decision', 'Last observation'].map((label) => h('th', { scope: 'col' }, label)))),
        h(
          'tbody',
          null,
          ...experiments.map((experiment) => h(
            'tr',
            { className: experiment.id === selectedId ? 'selected' : '', 'aria-selected': String(experiment.id === selectedId) },
            h('th', { scope: 'row' }, h('button', { type: 'button', onclick: () => onSelect(experiment.id) }, experiment.name)),
            h('td', null, experiment.workflow || UNKNOWN),
            h('td', null, `${experiment.control} → ${experiment.candidate}`),
            h('td', null, sourceLabel(experiment.primarySource, experiment.primaryId)),
            h('td', null, `${experiment.controlN} / ${experiment.candidateN}`, experiment.excluded ? h('small', null, `${experiment.excluded} excluded`) : null),
            h('td', null, renderEffect(experiment.normalizedEffect)),
            h('td', null, experiment.evidenceStrength),
            h('td', null, experiment.guardrailCount === 0
              ? renderExperimentBadge('Not configured', 'neutral')
              : renderExperimentBadge(`${experiment.guardrailCount - experiment.regressingGuardrails.length}/${experiment.guardrailCount} passing`, experiment.regressingGuardrails.length ? 'danger' : 'success')),
            h('td', null, renderExperimentBadge(experiment.readiness, experiment.readiness === 'READY' ? 'success' : 'attention')),
            h('td', null, renderExperimentBadge(experiment.decision, decisionTone(experiment.decision))),
            h('td', null, formatDate(experiment.lastObservation))
          ))
        )
      )
    )
  );
}

/** @param {ExperimentModel} model @param {string} experimentId @returns {HTMLElement} */
function renderExperimentDetails(model, experimentId) {
  const experiment = model.experiments.find((candidate) => candidate.id === experimentId);
  if (!experiment) return h('div');
  const metrics = metricSummaries(experiment.observations, experiment.control, experiment.candidate);
  const evalMetrics = metrics.filter((metric) => metric.sourceType === 'eval');
  const graderRegressions = metrics.filter((metric) => metric.sourceType === 'grader' && metric.regression).sort((left, right) => left.normalizedEffect - right.normalizedEffect);
  return h(
    'div',
    { className: 'experiment-detail', 'data-selected-experiment': experiment.id },
    h('div', { className: 'experiment-selection-heading' }, h('div', null, h('span', null, 'Selected experiment'), h('h2', null, experiment.name)), renderExperimentBadge(experiment.decision, decisionTone(experiment.decision))),
    renderExperimentDetailSection('metric-comparison', { metrics, experiment }),
    renderExperimentDetailSection('eval-outcomes', { metrics: evalMetrics, experiment }),
    renderExperimentDetailSection('grader-diagnostics', { metrics: graderRegressions }),
    renderExperimentDetailSection('observation-quality', { experiment }),
    renderExperimentDetailSection('run-evidence', { model, experiment })
  );
}

/** @param {any[]} observations @param {string} control @param {string} candidate @returns {any[]} */
function metricSummaries(observations, control, candidate) {
  /** @type {Map<string, Row[]>} */
  const groups = new Map();
  for (const observation of observations) {
    const key = `${observation.sourceType}:${observation.identifier}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const controlRows = group.filter((row) => row.variant === control && row.included);
    const candidateRows = group.filter((row) => row.variant === candidate && row.included);
    const controlValue = aggregateObservations(controlRows, first.sourceType);
    const candidateValue = aggregateObservations(candidateRows, first.sourceType);
    const rawEffect = difference(candidateValue, controlValue);
    const normalizedEffect = normalizeEffect(rawEffect, first.direction);
    const thresholdRegression = first.role === 'GUARDRAIL' && first.threshold !== null
      ? (first.direction === 'lower_is_better' ? candidateValue > first.threshold : candidateValue < first.threshold)
      : false;
    return {
      identifier: first.identifier,
      sourceType: first.sourceType,
      role: first.role,
      direction: first.direction,
      unit: first.unit,
      question: first.question,
      threshold: first.threshold,
      controlValue,
      candidateValue,
      rawEffect,
      normalizedEffect,
      controlN: controlRows.length,
      candidateN: candidateRows.length,
      excluded: group.length - controlRows.length - candidateRows.length,
      regression: thresholdRegression || (Number.isFinite(normalizedEffect) && normalizedEffect < 0)
    };
  }).sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.identifier.localeCompare(right.identifier));
}

/** @param {any[]} rows @param {string} sourceType @returns {number} */
function aggregateObservations(rows, sourceType) {
  if (sourceType === 'eval') {
    const known = rows.filter((row) => row.result === 'YES' || row.result === 'NO');
    return known.length ? known.filter((row) => row.result === 'YES').length / known.length : NaN;
  }
  return mean(rows.map(numericObservation).filter(Number.isFinite));
}

/** @param {any} observation @returns {number} */
function numericObservation(observation) {
  if (observation.sourceType === 'eval') return observation.result === 'YES' ? 1 : observation.result === 'NO' ? 0 : NaN;
  return finite(observation.result) ?? NaN;
}


/** @param {Map<string, number>} counts @returns {HTMLElement} */
function renderLegend(counts) {
  return h('ul', { className: 'experiment-state-legend' }, ...[...counts].map(([state, count]) => h('li', null, h('span', { className: `state-dot state-${state.toLowerCase()}` }), `${state} ${count}`)));
}

/** @param {string} label @param {unknown} value @returns {HTMLElement} */
function summaryItem(label, value) {
  return renderDlRow(label, String(value));
}

/** @param {number} value @returns {HTMLElement} */
function renderEffect(value) {
  if (!Number.isFinite(value)) return h('span', { className: 'effect effect-unknown' }, UNKNOWN, h('span', { className: 'sr-only' }, ' insufficient evidence'));
  const positive = value > 0;
  const negative = value < 0;
  return h(
    'span',
    { className: `effect ${positive ? 'effect-positive' : negative ? 'effect-negative' : 'effect-neutral'}` },
    `${positive ? '+' : ''}${value.toFixed(3)}`,
    positive ? ' ▲' : negative ? ' ▼' : ' ·',
    h('span', { className: 'sr-only' }, positive ? ' improvement' : negative ? ' regression' : ' no change')
  );
}

/** @param {string} source @param {string} identifier @returns {string} */
function sourceLabel(source, identifier) {
  return source === UNKNOWN ? identifier : `${source}:${identifier}`;
}

/** @param {string} value @returns {string} */
function formatDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : UNKNOWN;
}

/** @param {number} value @param {number} total @returns {number} */
function percentage(value, total) {
  return total > 0 ? value / total * 360 : 0;
}

/** @param {number} value @param {string} direction @returns {number} */
function normalizeEffect(value, direction) {
  if (!Number.isFinite(value)) return NaN;
  return direction === 'lower_is_better' ? -value : value;
}

/** @param {number} left @param {number} right @returns {number} */
function difference(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : NaN;
}

/** @param {number[]} values @returns {number} */
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/** @param {unknown} value @returns {number | null} */
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {any[]} rows @param {(row: any) => string} key @returns {Map<string, number>} */
function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** @param {string} role @returns {number} */
function roleOrder(role) {
  return role === 'PRIMARY' ? 0 : role === 'GUARDRAIL' ? 1 : 2;
}

/** @param {string} decision @returns {string} */
function decisionTone(decision) {
  if (decision === 'PROMOTE') return 'success';
  if (decision === 'REJECT') return 'danger';
  if (decision === 'READY' || decision === 'EXTEND') return 'attention';
  return 'neutral';
}
