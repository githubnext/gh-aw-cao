/**
 * Reusable experiment detail sections shared by the experiments decision surface.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderExperimentBadge } from './badge.js';
import { computeObservationCoverage, formatCoveragePercent } from './count-formatters.js';
import { renderExperimentEffect, renderExperimentSection, numericObservation, safeExperimentLink } from './experiment-view-primitives.js';
import { renderDisclosure } from './ui-primitives.js';

const UNKNOWN = '—';

/**
 * @param {string} message
 * @returns {HTMLElement}
 */
function partialState(message) {
  return h('div', { className: 'experiment-partial', role: 'status' }, octicon('info'), h('span', null, message));
}


/**
 * @param {unknown} value
 * @param {string} label
 * @returns {HTMLElement}
 */
function renderEvidenceLink(value, label) {
  const link = safeExperimentLink(value);
  return link ? h('a', { href: link.href, title: link.label || label }, label, octicon('link-external')) : h('span', null, label || UNKNOWN);
}

/**
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
function formatMetric(value, unit) {
  if (!Number.isFinite(value)) return UNKNOWN;
  if (unit === 'percent') return formatCoveragePercent(value);
  if (unit === 'seconds' || unit === 's') return `${value.toFixed(1)}s`;
  return Number(value.toFixed(3)).toString();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

/**
 * @param {Array<Record<string, any>>} metrics
 * @param {Record<string, any>} experiment
 * @returns {HTMLElement}
 */
function renderMetricComparisonSection(metrics, experiment) {
  return renderExperimentSection({
    id: 'metric-comparison-title',
    title: 'Variant × metric comparison',
    description: `${experiment.control} compared with ${experiment.candidate}; arrows account for metric direction.`,
    emptyState: metrics.length === 0 ? partialState('Assignments exist, but no grader or eval observations are available.') : null,
    renderContent: () => h(
      'div',
      { className: 'table-region experiment-metric-region' },
      h(
        'table',
        { className: 'experiment-metric-table' },
        h('thead', null, h('tr', null, ...['Role', 'Metric', 'Source', 'Direction', experiment.control, experiment.candidate, 'Δ normalized', 'Usable / excluded', 'Threshold'].map((label) => h('th', { scope: 'col' }, label)))),
        h('tbody', null, ...metrics.map((metric) => h(
          'tr',
          null,
          h('td', null, renderExperimentBadge(metric.role, metric.role === 'GUARDRAIL' ? 'attention' : 'neutral')),
          h('th', { scope: 'row' }, metric.identifier),
          h('td', null, metric.sourceType),
          h('td', null, metric.direction.replaceAll('_', ' ')),
          h('td', null, formatMetric(metric.controlValue, metric.unit)),
          h('td', null, formatMetric(metric.candidateValue, metric.unit)),
          h('td', null, renderExperimentEffect(metric.normalizedEffect)),
          h('td', null, `${metric.controlN + metric.candidateN} / ${metric.excluded}`),
          h('td', null, metric.threshold === null ? UNKNOWN : formatMetric(metric.threshold, metric.unit))
        )))
      )
    )
  });
}

/**
 * @param {string} label
 * @param {Array<Record<string, any>>} rows
 * @returns {HTMLElement}
 */
function renderEvalBar(label, rows) {
  const includedRows = rows.filter((row) => row.included);
  const yes = includedRows.filter((row) => row.result === 'YES').length;
  const no = includedRows.filter((row) => row.result === 'NO').length;
  const unknown = includedRows.length - yes - no;
  const total = includedRows.length || 1;
  return h(
    'div',
    { className: 'eval-bar-row' },
    h('span', null, label),
    h(
      'div',
      { className: 'eval-stacked-bar', role: 'img', 'aria-label': `${label}: ${yes} yes, ${no} no, ${unknown} unknown or missing` },
      h('span', { className: 'yes', style: `width:${yes / total * 100}%` }, yes ? `YES ${yes}` : ''),
      h('span', { className: 'no', style: `width:${no / total * 100}%` }, no ? `NO ${no}` : ''),
      h('span', { className: 'unknown', style: `width:${unknown / total * 100}%` }, unknown ? `? ${unknown}` : '')
    )
  );
}

/**
 * @param {Array<Record<string, any>>} metrics
 * @param {Record<string, any>} experiment
 * @returns {HTMLElement}
 */
function renderEvalOutcomesSection(metrics, experiment) {
  return renderExperimentSection({
    id: 'eval-outcomes-title',
    title: 'Eval outcomes',
    description: 'Unknown and missing answers remain separate from NO.',
    emptyState: metrics.length === 0 ? partialState('No eval observations are available for this experiment.') : null,
    renderContent: () => h('div', { className: 'eval-outcome-list' }, ...metrics.map((metric) => {
      const matching = /** @type {Array<Record<string, any>>} */ (experiment.observations).filter((row) => row.sourceType === 'eval' && row.identifier === metric.identifier);
      return h(
        'article',
        { className: 'eval-outcome' },
        h('header', null, h('div', null, h('strong', null, metric.question || metric.identifier), h('span', null, `${metric.identifier} · ${metric.candidateN + metric.controlN} usable · ${metric.excluded} excluded`)), renderExperimentEffect(metric.normalizedEffect)),
        renderEvalBar(experiment.control, matching.filter((row) => row.variant === experiment.control)),
        renderEvalBar(experiment.candidate, matching.filter((row) => row.variant === experiment.candidate))
      );
    }))
  });
}

/**
 * @param {Array<Record<string, any>>} metrics
 * @returns {HTMLElement}
 */
function renderGraderDiagnosticsSection(metrics) {
  return renderExperimentSection({
    id: 'grader-diagnostics-title',
    title: 'Grader regressions',
    description: 'Largest direction-aware regressions are ranked first.',
    emptyState: metrics.length === 0 ? partialState('No grader regressions are present in the available observations.') : null,
    renderContent: () => h(
      'ol',
      { className: 'grader-ranking' },
      ...metrics.map((metric) => h(
        'li',
        null,
        h('span', { className: 'grader-rank-icon', 'aria-hidden': 'true' }, metric.regression ? octicon('arrow-down') : octicon('arrow-up')),
        h('strong', null, metric.identifier),
        h('span', null, renderExperimentEffect(metric.normalizedEffect)),
        h('span', null, `N ${metric.controlN + metric.candidateN}`),
        renderExperimentBadge(metric.role, metric.regression ? 'danger' : 'neutral')
      ))
    )
  });
}

/**
 * @param {Record<string, any>} experiment
 * @returns {HTMLElement}
 */
function renderObservationQualitySection(experiment) {
  const observations = /** @type {Array<Record<string, any>>} */ (experiment.observations);
  const assignments = /** @type {Array<Record<string, any>>} */ (experiment.assignments);
  const reasons = countBy(
    observations.filter((observation) => !observation.included),
    (observation) => observation.exclusionReason || `${observation.sourceType} missing`
  );
  const assignedRuns = new Set(assignments.map((row) => text(row.run)).filter(Boolean)).size;
  const coverage = computeObservationCoverage(experiment.usable, experiment.excluded);
  return renderExperimentSection({
    id: 'observation-quality-title',
    title: 'Observation quality and exclusions',
    description: 'Coverage is calculated from observations, not successful workflow executions.',
    className: 'observation-quality',
    renderContent: () => h(
      'div',
      null,
      coverage !== null && coverage < .9 ? h('div', { className: 'experiment-warning', role: 'note' }, octicon('alert'), h('span', null, 'Large effects require caution because usable observation coverage is below 90%.')) : null,
      h(
        'div',
        { className: 'exclusion-flow' },
        h('div', null, h('span', null, 'Assigned runs'), h('strong', null, String(assignedRuns))),
        h('div', null, h('span', null, 'Usable observations'), h('strong', null, String(experiment.usable)), h('small', null, formatCoveragePercent(coverage))),
        h('div', null, h('span', null, 'Excluded'), h('strong', null, String(experiment.excluded))),
        h('ul', null, ...[...reasons].map(([reason, count]) => h('li', null, h('span', null, reason), h('strong', null, String(count)))))
      )
    )
  });
}

/**
 * @param {Record<string, any>} row
 * @returns {HTMLElement}
 */
function renderEvidenceActions(row) {
  const links = [
    ['Assignment', row.assignment['assignment-link']],
    ['Workflow execution', row.run['run-link']],
    ['Artifacts', row.assignment['artifact-link']],
    ['Trace', row.assignment['trace-link']],
    .../** @type {Array<Record<string, any>>} */ (row.observations).map((observation) => [observation.sourceType === 'eval' ? 'Eval' : 'Grader', observation.evidenceLink])
  ].filter(([, value]) => safeExperimentLink(value));
  return links.length
    ? renderDisclosure('evidence-menu', 'Open evidence', h('ul', null, ...links.map(([label, value]) => h('li', null, renderEvidenceLink(value, label)))))
    : h('span', { className: 'muted' }, 'Unavailable');
}

/**
 * @param {{ runById: Map<string, Record<string, any>> }} model
 * @param {Record<string, any>} experiment
 * @returns {HTMLElement}
 */
function renderRunEvidenceSection(model, experiment) {
  const assignments = /** @type {Array<Record<string, any>>} */ (experiment.assignments);
  const experimentObservations = /** @type {Array<Record<string, any>>} */ (experiment.observations);
  const rows = assignments.map((assignment) => {
    const run = model.runById.get(text(assignment.run)) ?? {};
    const observations = experimentObservations.filter((observation) => text(observation.run) === text(assignment.run));
    const primary = observations.find((observation) => observation.identifier === experiment.primaryId);
    const guardrails = observations.filter((observation) => observation.role === 'GUARDRAIL');
    const evals = observations.filter((observation) => observation.sourceType === 'eval');
    const included = observations.some((observation) => observation.included);
    const reason = [...new Set([
      text(assignment['exclusion-reason']),
      ...observations.filter((observation) => !observation.included).map((observation) => observation.exclusionReason)
    ].filter(Boolean))].join(', ');
    return { assignment, run, observations, primary, guardrails, evals, included, reason };
  });
  return renderExperimentSection({
    id: 'run-evidence-title',
    title: 'Run evidence',
    description: 'Inspect assignments, observations, exclusions, and retained supporting evidence.',
    emptyState: rows.length === 0 ? partialState('Experiment configured, but no assignments are available.') : null,
    renderContent: () => h(
      'div',
      { className: 'table-region run-evidence-region' },
      h(
        'table',
        { className: 'run-evidence-table' },
        h('thead', null, h('tr', null, ...['Run', 'Variant', 'Primary', 'Guardrails', 'Evals', 'Included', 'Reason', 'Evidence'].map((label) => h('th', { scope: 'col' }, label)))),
        h('tbody', null, ...rows.map((row) => h(
          'tr',
          null,
          h('th', { scope: 'row' }, renderEvidenceLink(row.run['run-link'], text(row.assignment.run))),
          h('td', null, text(row.assignment.variant) || UNKNOWN),
          h('td', null, row.primary ? formatMetric(numericObservation(row.primary), row.primary.unit) : UNKNOWN),
          h('td', null, row.guardrails.length ? renderExperimentBadge(row.guardrails.some((observation) => !observation.included) ? 'Review' : `${row.guardrails.length}/${row.guardrails.length}`, row.guardrails.some((observation) => !observation.included) ? 'danger' : 'success') : UNKNOWN),
          h('td', null, row.evals.length ? `${row.evals.filter((observation) => observation.included).length}/${row.evals.length}` : UNKNOWN),
          h('td', null, row.included ? 'Yes' : 'No'),
          h('td', null, row.reason || UNKNOWN),
          h('td', null, renderEvidenceActions(row))
        )))
      )
    )
  });
}

/**
 * @param {string} section
 * @param {{ metrics?: Array<Record<string, any>>, experiment?: Record<string, any>, model?: { runById: Map<string, Record<string, any>> } }} context
 * @returns {HTMLElement}
 */
export function renderExperimentDetailSection(section, context) {
  if (section === 'metric-comparison') return renderMetricComparisonSection(context.metrics ?? [], context.experiment ?? {});
  if (section === 'eval-outcomes') return renderEvalOutcomesSection(context.metrics ?? [], context.experiment ?? {});
  if (section === 'grader-diagnostics') return renderGraderDiagnosticsSection(context.metrics ?? []);
  if (section === 'observation-quality') return renderObservationQualitySection(context.experiment ?? {});
  if (section === 'run-evidence') return renderRunEvidenceSection(context.model ?? { runById: new Map() }, context.experiment ?? {});
  throw new Error(`Unknown experiment detail section: "${section}". Expected one of: metric-comparison, eval-outcomes, grader-diagnostics, observation-quality, run-evidence`);
}

/** @param {Array<Record<string, any>>} rows @param {(row: Record<string, any>) => string} key @returns {Map<string, number>} */
function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

