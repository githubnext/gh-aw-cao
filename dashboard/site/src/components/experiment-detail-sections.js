/**
 * Reusable experiment detail sections shared by the experiments decision surface.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderExperimentBadge } from './badge.js';
import { isSafeHttpsUrl } from './ui-primitives.js';

const UNKNOWN = '—';

/**
 * @param {string} id
 * @param {string} title
 * @param {string} description
 * @returns {HTMLElement}
 */
function sectionHeading(id, title, description) {
  return h('header', { className: 'experiment-section-heading' }, h('div', null, h('h2', { id }, title), h('p', null, description)));
}

/**
 * @param {string} message
 * @returns {HTMLElement}
 */
function partialState(message) {
  return h('div', { className: 'experiment-partial', role: 'status' }, octicon('info'), h('span', null, message));
}

/**
 * @param {number} value
 * @returns {HTMLElement}
 */
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

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {HTMLElement}
 */
function renderEvidenceLink(value, label) {
  const link = safeLink(value);
  return link ? h('a', { href: link.href, title: link.label || label }, label, octicon('link-external')) : h('span', null, label || UNKNOWN);
}

/**
 * @param {unknown} value
 * @returns {{href: string, label: string} | null}
 */
function safeLink(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = /** @type {{ href: string, label?: unknown }} */ (value);
  if (typeof candidate.href !== 'string' || !isSafeHttpsUrl(candidate.href)) return null;
  return { href: candidate.href, label: text(candidate.label) };
}

/**
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
function formatMetric(value, unit) {
  if (!Number.isFinite(value)) return UNKNOWN;
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
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
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'metric-comparison-title' },
    sectionHeading('metric-comparison-title', 'Variant × metric comparison', `${experiment.control} compared with ${experiment.candidate}; arrows account for metric direction.`),
    metrics.length === 0
      ? partialState('Assignments exist, but no grader or eval observations are available.')
      : h(
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
            h('td', null, renderEffect(metric.normalizedEffect)),
            h('td', null, `${metric.controlN + metric.candidateN} / ${metric.excluded}`),
            h('td', null, metric.threshold === null ? UNKNOWN : formatMetric(metric.threshold, metric.unit))
          )))
        )
      )
  );
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
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'eval-outcomes-title' },
    sectionHeading('eval-outcomes-title', 'Eval outcomes', 'Unknown and missing answers remain separate from NO.'),
    metrics.length === 0
      ? partialState('No eval observations are available for this experiment.')
      : h('div', { className: 'eval-outcome-list' }, ...metrics.map((metric) => {
        const matching = /** @type {Array<Record<string, any>>} */ (experiment.observations).filter((row) => row.sourceType === 'eval' && row.identifier === metric.identifier);
        return h(
          'article',
          { className: 'eval-outcome' },
          h('header', null, h('div', null, h('strong', null, metric.question || metric.identifier), h('span', null, `${metric.identifier} · ${metric.candidateN + metric.controlN} usable · ${metric.excluded} excluded`)), renderEffect(metric.normalizedEffect)),
          renderEvalBar(experiment.control, matching.filter((row) => row.variant === experiment.control)),
          renderEvalBar(experiment.candidate, matching.filter((row) => row.variant === experiment.candidate))
        );
      }))
  );
}

/**
 * @param {Array<Record<string, any>>} metrics
 * @returns {HTMLElement}
 */
function renderGraderDiagnosticsSection(metrics) {
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'grader-diagnostics-title' },
    sectionHeading('grader-diagnostics-title', 'Grader regressions', 'Largest direction-aware regressions are ranked first.'),
    metrics.length === 0
      ? partialState('No grader regressions are present in the available observations.')
      : h(
        'ol',
        { className: 'grader-ranking' },
        ...metrics.map((metric) => h(
          'li',
          null,
          h('span', { className: 'grader-rank-icon', 'aria-hidden': 'true' }, metric.regression ? octicon('arrow-down') : octicon('arrow-up')),
          h('strong', null, metric.identifier),
          h('span', null, renderEffect(metric.normalizedEffect)),
          h('span', null, `N ${metric.controlN + metric.candidateN}`),
          renderExperimentBadge(metric.role, metric.regression ? 'danger' : 'neutral')
        ))
      )
  );
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
  const coverage = experiment.usable + experiment.excluded > 0 ? experiment.usable / (experiment.usable + experiment.excluded) : null;
  return h(
    'section',
    { className: 'experiment-section observation-quality', 'aria-labelledby': 'observation-quality-title' },
    sectionHeading('observation-quality-title', 'Observation quality and exclusions', 'Coverage is calculated from observations, not successful workflow executions.'),
    coverage !== null && coverage < .9 ? h('div', { className: 'experiment-warning', role: 'note' }, octicon('alert'), h('span', null, 'Large effects require caution because usable observation coverage is below 90%.')) : null,
    h(
      'div',
      { className: 'exclusion-flow' },
      h('div', null, h('span', null, 'Assigned runs'), h('strong', null, String(assignedRuns))),
      h('div', null, h('span', null, 'Usable observations'), h('strong', null, String(experiment.usable)), h('small', null, coverage === null ? UNKNOWN : `${(coverage * 100).toFixed(1)}%`)),
      h('div', null, h('span', null, 'Excluded'), h('strong', null, String(experiment.excluded))),
      h('ul', null, ...[...reasons].map(([reason, count]) => h('li', null, h('span', null, reason), h('strong', null, String(count)))))
    )
  );
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
  ].filter(([, value]) => safeLink(value));
  return links.length
    ? h('details', { className: 'evidence-menu' }, h('summary', null, 'Open evidence'), h('ul', null, ...links.map(([label, value]) => h('li', null, renderEvidenceLink(value, label)))))
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
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'run-evidence-title' },
    sectionHeading('run-evidence-title', 'Run evidence', 'Inspect assignments, observations, exclusions, and retained supporting evidence.'),
    rows.length === 0
      ? partialState('Experiment configured, but no assignments are available.')
      : h(
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
  );
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

/** @param {Record<string, any>} observation @returns {number} */
function numericObservation(observation) {
  if (observation.sourceType === 'eval') return observation.result === 'YES' ? 1 : observation.result === 'NO' ? 0 : NaN;
  const value = Number(observation.result);
  return Number.isFinite(value) ? value : NaN;
}
