import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { rowsFor } from './source-rows.js';
import { renderExperimentDetailSection } from './experiment-detail-sections.js';
import { renderDlRow, isSafeHttpsUrl } from './ui-primitives.js';

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
  const model = buildModel(context.sources);
  const pageId = context.pageId;
  if (model.experiments.length === 0) {
    return renderEmptyState(context.sources);
  }

  const root = h('div', { className: 'experiments-evaluation' });
  const filters = initialFilters(model);
  let selectedExperiment = filters.experiment || model.experiments[0].id;

  const render = () => {
    const visible = filterExperiments(model.experiments, filters);
    if (!visible.some((experiment) => experiment.id === selectedExperiment)) {
      selectedExperiment = visible[0]?.id ?? '';
    }
    root.replaceChildren(
      renderFilterBar(model, filters, () => {
        syncDeepLink(filters, selectedExperiment, pageId);
        render();
      }),
      renderDecisionOverview(visible),
      renderDecisionTable(visible, selectedExperiment, (experimentId) => {
        selectedExperiment = experimentId;
        filters.experiment = experimentId;
        syncDeepLink(filters, selectedExperiment, pageId);
        render();
      }),
      visible.length === 0
        ? h('div', { className: 'experiment-empty', role: 'status' }, h('strong', null, 'No experiments match the selected filters.'), h('p', null, 'Clear one or more filters to restore the decision view.'))
        : renderExperimentDetails(model, selectedExperiment)
    );
  };

  render();
  return root;
}

/** @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources @returns {ExperimentModel} */
function buildModel(sources) {
  const experimentRows = rowsFor(sources, 'experiments');
  const assignments = rowsFor(sources, 'experiment-assignments');
  const graderDefinitions = rowsFor(sources, 'graders');
  const evalDefinitions = rowsFor(sources, 'evals');
  const runs = rowsFor(sources, 'runs');
  const assignmentByRun = new Map(assignments.map((row) => [text(row.run), row]));
  const runById = new Map(runs.map((row) => [text(row.run), row]));
  const graderById = new Map(graderDefinitions.map((row) => [text(row.grader), row]));
  const evalById = new Map(evalDefinitions.map((row) => [text(row.eval), row]));
  const graders = rowsFor(sources, 'grader-observations').map((row) => normalizeObservation(row, assignmentByRun, graderById.get(text(row.grader)), 'grader'));
  const evals = rowsFor(sources, 'eval-observations').map((row) => normalizeObservation(row, assignmentByRun, evalById.get(text(row.eval)), 'eval'));
  const experimentIds = new Set([
    ...experimentRows.map((row) => text(row.experiment)),
    ...assignments.map((row) => text(row.experiment)),
    ...graders.map((row) => row.experiment),
    ...evals.map((row) => row.experiment)
  ].filter(Boolean));
  const definitionById = new Map(experimentRows.map((row) => [text(row.experiment), row]));
  const experiments = [...experimentIds].map((id) => summarizeExperiment({
    id,
    definition: definitionById.get(id) ?? {},
    assignments: assignments.filter((row) => text(row.experiment) === id),
    graders: graders.filter((row) => row.experiment === id),
    evals: evals.filter((row) => row.experiment === id)
  })).sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  return { experiments, assignments, graders, evals, runById, graderById, evalById };
}

/** @param {any} row @param {any} assignmentByRun @param {any} definition @param {string} sourceType @returns {any} */
function normalizeObservation(row, assignmentByRun, definition, sourceType) {
  const assignment = assignmentByRun.get(text(row.run)) ?? {};
  const identifier = text(sourceType === 'grader' ? row.grader : row.eval);
  const result = sourceType === 'grader' ? finite(row.value) : normalizeEvalResult(row['eval-result'] ?? row.result);
  return {
    ...row,
    experiment: text(row.experiment || assignment.experiment),
    variant: text(row.variant || assignment.variant || 'unknown'),
    identifier,
    sourceType,
    result,
    role: upper(row.role || definition?.role || 'SECONDARY'),
    direction: text(row.direction || definition?.direction || 'higher_is_better'),
    unit: text(row.unit || definition?.unit || (sourceType === 'eval' ? 'answer' : 'raw')),
    question: text(row.question || (definition && definition['eval-question'])),
    threshold: finite(row.threshold ?? definition?.threshold),
    included: includedObservation(row) && includedAssignment(assignment),
    exclusionReason: text(row['exclusion-reason'] || row.reason || assignment['exclusion-reason']),
    observedAt: text(row['observed-at']),
    evidenceLink: safeLink(row['evidence-link']) || safeLink(row['grader-link']) || safeLink(row['eval-link'])
  };
}

/** @param {{ id: string, definition: Row, assignments: Row[], graders: Row[], evals: Row[] }} input @returns {Row} */
function summarizeExperiment(input) {
  const { id, definition, assignments, graders, evals } = input;
  const observations = [...graders, ...evals];
  const variants = [...new Set(assignments.map((row) => text(row.variant)).filter(Boolean))];
  const control = text(definition['control-variant'] || variants.find((variant) => /control|baseline/i.test(variant)) || variants[0] || 'control');
  const candidate = text(definition['candidate-variant'] || variants.find((variant) => variant !== control) || variants[1] || 'candidate');
  const primaryId = text(definition['primary-metric'] || observations.find((observation) => observation.role === 'PRIMARY')?.identifier);
  const primary = observations.filter((observation) => observation.identifier === primaryId && observation.included);
  const controlValues = primary.filter((observation) => observation.variant === control).map(numericObservation).filter(Number.isFinite);
  const candidateValues = primary.filter((observation) => observation.variant === candidate).map(numericObservation).filter(Number.isFinite);
  const rawEffect = finite(definition.effect) ?? difference(mean(candidateValues), mean(controlValues));
  const direction = primary[0]?.direction || text(definition.direction || 'higher_is_better');
  const normalizedEffect = finite(definition['normalized-effect']) ?? normalizeEffect(rawEffect, direction);
  const guardrails = metricSummaries(observations, control, candidate).filter((metric) => metric.role === 'GUARDRAIL');
  const regressingGuardrails = guardrails.filter((metric) => metric.regression);
  const usable = observations.filter((observation) => observation.included).length;
  const excluded = observations.length - usable;
  const readiness = upper(definition.readiness || definition.state || 'COLLECTING');
  const decision = upper(definition.decision || (readiness === 'READY' ? 'INCONCLUSIVE' : readiness));
  const lastObservation = observations.map((observation) => observation.observedAt).filter(Boolean).sort().at(-1) || text(definition['last-observation']);
  return {
    id,
    name: text(definition['experiment-name'] || id),
    organization: text(definition.organization || assignments[0]?.organization),
    repository: text(definition.repository || assignments[0]?.repository),
    package: text(definition.package || assignments[0]?.package),
    workflow: text(definition.workflow || assignments[0]?.workflow),
    control,
    candidate,
    primaryId: primaryId || UNKNOWN,
    primarySource: primary[0]?.sourceType || text(definition['primary-source']) || UNKNOWN,
    controlN: primary.filter((observation) => observation.variant === control).length,
    candidateN: primary.filter((observation) => observation.variant === candidate).length,
    usable,
    excluded,
    readiness,
    decision,
    normalizedEffect,
    evidenceStrength: text(definition['evidence-strength'] || readinessLabel(readiness)),
    guardrailCount: guardrails.length,
    regressingGuardrails,
    lastObservation,
    observations,
    assignments,
    priority: regressingGuardrails.length > 0 ? 0 : readiness === 'READY' ? 1 : readiness === 'COLLECTING' ? 2 : 3
  };
}

/** @param {ExperimentModel} model @param {ExperimentFilters} filters @param {() => void} onChange @returns {HTMLElement} */
function renderFilterBar(model, filters, onChange) {
  /** @type {Array<[string, string, string[]]>} */
  const controls = [
    ['organization', 'Organization', distinct(model.experiments, 'organization')],
    ['repository', 'Repository', distinct(model.experiments, 'repository')],
    ['package', 'Package', distinct(model.experiments, 'package')],
    ['workflow', 'Workflow / agent', distinct(model.experiments, 'workflow')],
    ['experiment', 'Experiment', model.experiments.map((item) => item.id)],
    ['state', 'State', distinct(model.experiments, 'readiness')],
    ['variant', 'Variant', [...new Set(model.experiments.flatMap((item) => [item.control, item.candidate]))]],
    ['source', 'Metric source', ['grader', 'eval']],
    ['metric', 'Grader / eval', [...new Set([...model.graders, ...model.evals].map((row) => row.identifier).filter(Boolean))]]
  ];
  return h(
    'form',
    { className: 'experiment-filters', 'aria-label': 'Experiments and evaluation filters', onsubmit: /** @param {SubmitEvent} event */ (event) => event.preventDefault() },
    ...controls.map(([key, label, values]) => {
      const select = h(
        'select',
        {
          name: key,
          'aria-label': label,
          onchange: /** @param {Event} event */ (event) => {
            filters[key] = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
            onChange();
          }
        },
        h('option', { value: '' }, `All ${label.toLowerCase()}`),
        ...values.map((value) => h('option', { value, selected: filters[key] === value }, value))
      );
      return h('label', null, h('span', null, label), select);
    }),
    h(
      'label',
      null,
      h('span', null, 'Date range'),
      h(
        'select',
        {
          name: 'range',
          'aria-label': 'Date range',
          onchange: /** @param {Event} event */ (event) => {
            filters.range = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
            onChange();
          }
        },
        ...[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['all', 'All recorded']].map(([value, label]) => h('option', { value, selected: filters.range === value }, label))
      )
    )
  );
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

/** @param {string} id @param {string} title @param {string} description @returns {HTMLElement} */
function sectionHeading(id, title, description) {
  return h('header', { className: 'experiment-section-heading' }, h('div', null, h('h2', { id }, title), h('p', null, description)));
}

/** @param {any[]} experiments @param {string} selectedId @param {(id: string) => void} onSelect @returns {HTMLElement} */
function renderDecisionTable(experiments, selectedId, onSelect) {
  return h(
    'section',
    { className: 'experiment-section', 'aria-labelledby': 'experiment-decisions-title' },
    sectionHeading('experiment-decisions-title', 'Experiment decisions', 'Guardrail failures and decision-ready experiments are shown first.'),
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
              ? statusBadge('Not configured', 'neutral')
              : statusBadge(`${experiment.guardrailCount - experiment.regressingGuardrails.length}/${experiment.guardrailCount} passing`, experiment.regressingGuardrails.length ? 'danger' : 'success')),
            h('td', null, statusBadge(experiment.readiness, experiment.readiness === 'READY' ? 'success' : 'attention')),
            h('td', null, statusBadge(experiment.decision, decisionTone(experiment.decision))),
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
    h('div', { className: 'experiment-selection-heading' }, h('div', null, h('span', null, 'Selected experiment'), h('h2', null, experiment.name)), statusBadge(experiment.decision, decisionTone(experiment.decision))),
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


/** @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources @returns {HTMLElement} */
function renderEmptyState(sources) {
  const experimentSource = sources.experiments;
  const unavailable = experimentSource?.metadata?.availability === 'unavailable';
  return h(
    'div',
    { className: 'experiment-empty', role: 'status' },
    octicon(unavailable ? 'alert' : 'beaker'),
    h('strong', null, unavailable ? 'Experiment source unavailable' : 'No experiments configured'),
    h('p', null, unavailable
      ? 'Experiment definitions could not be accessed. No decision can be calculated.'
      : 'Configure an experiment and retain assignments before evaluating candidate outcomes.')
  );
}

/** @param {ExperimentModel} model @returns {ExperimentFilters} */
function initialFilters(model) {
  const hash = globalThis.window?.location?.hash ?? '';
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const parameters = new URLSearchParams(query);
  const requestedExperiment = parameters.get('experiment') ?? '';
  return {
    organization: parameters.get('organization') ?? '',
    repository: parameters.get('repository') ?? '',
    package: parameters.get('package') ?? '',
    workflow: parameters.get('workflow') ?? '',
    experiment: model.experiments.some((item) => item.id === requestedExperiment) ? requestedExperiment : '',
    state: parameters.get('state') ?? '',
    variant: parameters.get('variant') ?? '',
    source: parameters.get('source') ?? '',
    metric: parameters.get('metric') ?? '',
    range: parameters.get('range') ?? '30d'
  };
}

/** @param {Row[]} experiments @param {ExperimentFilters} filters @returns {Row[]} */
function filterExperiments(experiments, filters) {
  const rangeDays = /^(\d+)d$/.exec(filters.range)?.[1];
  const cutoff = rangeDays ? Date.now() - Number(rangeDays) * 86_400_000 : null;
  return experiments.filter((experiment) => {
    const observations = /** @type {Row[]} */ (experiment.observations);
    if (filters.organization && experiment.organization !== filters.organization) return false;
    if (filters.repository && experiment.repository !== filters.repository) return false;
    if (filters.package && experiment.package !== filters.package) return false;
    if (filters.workflow && experiment.workflow !== filters.workflow) return false;
    if (filters.experiment && experiment.id !== filters.experiment) return false;
    if (filters.state && experiment.readiness !== filters.state) return false;
    if (filters.variant && ![experiment.control, experiment.candidate].includes(filters.variant)) return false;
    if (filters.source && !observations.some((row) => row.sourceType === filters.source)) return false;
    if (filters.metric && !observations.some((row) => row.identifier === filters.metric)) return false;
    if (cutoff && experiment.lastObservation && Date.parse(experiment.lastObservation) < cutoff) return false;
    return true;
  });
}

/** @param {ExperimentFilters} filters @param {string} experimentId @param {string} pageId */
function syncDeepLink(filters, experimentId, pageId) {
  const window = globalThis.window;
  if (!window || !['http:', 'https:'].includes(window.location.protocol)) return;
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, experiment: experimentId })) {
    if (value && !(key === 'range' && value === '30d')) parameters.set(key, value);
  }
  const query = parameters.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#page-${encodeURIComponent(pageId)}${query ? `?${query}` : ''}`);
}

/** @param {Map<string, number>} counts @returns {HTMLElement} */
function renderLegend(counts) {
  return h('ul', { className: 'experiment-state-legend' }, ...[...counts].map(([state, count]) => h('li', null, h('span', { className: `state-dot state-${state.toLowerCase()}` }), `${state} ${count}`)));
}

/** @param {string} label @param {unknown} value @returns {HTMLElement} */
function summaryItem(label, value) {
  return renderDlRow(label, String(value));
}

/** @param {string} label @param {string} tone @returns {HTMLElement} */
function statusBadge(label, tone) {
  return h('span', { className: `experiment-badge experiment-badge-${tone}` }, tone === 'danger' ? octicon('alert-fill') : tone === 'success' ? octicon('check-circle-fill') : null, label);
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

/** @param {unknown} value @returns {{href: string, label: string} | null} */
function safeLink(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = /** @type {{ href: string, label?: unknown }} */ (value);
  if (typeof candidate.href !== 'string' || !isSafeHttpsUrl(candidate.href)) return null;
  return { href: candidate.href, label: text(candidate.label) };
}

/** @param {string} source @param {string} identifier @returns {string} */
function sourceLabel(source, identifier) {
  return source === UNKNOWN ? identifier : `${source}:${identifier}`;
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

/** @param {any} row @returns {boolean} */
function includedObservation(row) {
  if (row.included === false || text(row.included).toLowerCase() === 'no') return false;
  if (row['exclusion-reason']) return false;
  return !['missing', 'failed', 'error', 'unavailable'].includes(text(row.status).toLowerCase());
}

/** @param {any} row @returns {boolean} */
function includedAssignment(row) {
  if (row.included === false || text(row.included).toLowerCase() === 'no') return false;
  return !row['exclusion-reason'];
}

/** @param {unknown} value @returns {string} */
function normalizeEvalResult(value) {
  const normalized = upper(value);
  return normalized === 'YES' || normalized === 'NO' ? normalized : 'UNKNOWN';
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

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

/** @param {unknown} value @returns {string} */
function upper(value) {
  return text(value).replaceAll('-', '_').replaceAll(' ', '_').toUpperCase();
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

/** @param {any[]} rows @param {(row: any) => string} key @returns {Map<string, number>} */
function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** @param {any[]} rows @param {string} field @returns {string[]} */
function distinct(rows, field) {
  return [...new Set(rows.map((row) => text(row[field])).filter(Boolean))].sort();
}

/** @param {string} role @returns {number} */
function roleOrder(role) {
  return role === 'PRIMARY' ? 0 : role === 'GUARDRAIL' ? 1 : 2;
}

/** @param {string} readiness @returns {string} */
function readinessLabel(readiness) {
  return readiness === 'READY' ? 'Sufficient' : readiness === 'COLLECTING' ? 'Collecting' : 'Insufficient';
}

/** @param {string} decision @returns {string} */
function decisionTone(decision) {
  if (decision === 'PROMOTE') return 'success';
  if (decision === 'REJECT') return 'danger';
  if (decision === 'READY' || decision === 'EXTEND') return 'attention';
  return 'neutral';
}
