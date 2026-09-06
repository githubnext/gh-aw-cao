/**
 * Shared experiment decision surface composition and reusable subcomponents.
 */

import { h } from '../dom.js';
import { text } from './count-formatters.js';
import { rowsFor } from './source-rows.js';
import { experimentsViewComposition } from './experiments-view-composition.js';
import {
  difference,
  finite,
  mean,
  metricSummaries,
  normalizeEffect,
  numericObservation,
  safeExperimentLink
} from './experiment-view-primitives.js';
import { octicon } from '../octicons.js';

/** @typedef {Record<string, any>} Row */
/** @typedef {Row} ExperimentSummary */
/** @typedef {{ experiments: ExperimentSummary[], assignments: Row[], graders: Row[], evals: Row[], runById: Map<string, Row>, graderById: Map<string, Row>, evalById: Map<string, Row> }} ExperimentModel */
/** @typedef {Record<string, string>} ExperimentFilters */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {{
 *   buildModel: (sources: Record<string, import('../presenter.js').LogicalSourceInput>) => ExperimentModel,
 *   renderFilterBar: (model: ExperimentModel, filters: ExperimentFilters, onChange: () => void) => HTMLElement,
 *   filterExperiments: (experiments: ExperimentSummary[], filters: ExperimentFilters) => ExperimentSummary[],
 *   initialFilters: (model: ExperimentModel) => ExperimentFilters,
 *   syncDeepLink: (filters: ExperimentFilters, selectedExperiment: string, pageId: string) => void,
 *   renderEmptyState: (sources: Record<string, import('../presenter.js').LogicalSourceInput>) => HTMLElement,
 *   renderOverview: (experiments: ExperimentSummary[]) => HTMLElement,
 *   renderTable: (experiments: ExperimentSummary[], selectedId: string, onSelect: (id: string) => void) => HTMLElement,
 *   renderDetail: (model: ExperimentModel, selectedId: string) => HTMLElement,
 *   renderNoMatches: () => HTMLElement
 * }} callbacks
 * @returns {HTMLElement}
 */
export function renderExperimentDecisionSurface(context, callbacks) {
  const model = callbacks.buildModel(context.sources);
  if (model.experiments.length === 0) {
    return callbacks.renderEmptyState(context.sources);
  }

  const root = h('div', { className: 'experiments-evaluation' });
  const filters = callbacks.initialFilters(model);
  let selectedExperiment = filters.experiment || model.experiments[0].id;
  const composition = experimentsViewComposition(context.elementConfig);

  const render = () => {
    const visible = callbacks.filterExperiments(model.experiments, filters);
    if (!visible.some((experiment) => experiment.id === selectedExperiment)) {
      selectedExperiment = visible[0]?.id ?? '';
    }
    root.replaceChildren(
      callbacks.renderFilterBar(model, filters, () => {
        callbacks.syncDeepLink(filters, selectedExperiment, context.pageId);
        render();
      }),
      ...composition.map((section) =>
        renderExperimentDecisionSurfaceSection(section.key, {
          experiments: visible,
          model,
          selectedExperiment,
          onSelect: (experimentId) => {
            selectedExperiment = experimentId;
            filters.experiment = experimentId;
            callbacks.syncDeepLink(filters, selectedExperiment, context.pageId);
            render();
          },
          renderOverview: callbacks.renderOverview,
          renderTable: callbacks.renderTable,
          renderDetail: callbacks.renderDetail,
          renderNoMatches: callbacks.renderNoMatches
        })
      )
    );
  };

  render();
  return root;
}

/**
 * @param {'overview'|'table'|'detail'} section
 * @param {{
 *   experiments: ExperimentSummary[],
 *   model: ExperimentModel,
 *   selectedExperiment: string,
 *   onSelect: (id: string) => void,
 *   renderOverview: (experiments: ExperimentSummary[]) => HTMLElement,
 *   renderTable: (experiments: ExperimentSummary[], selectedId: string, onSelect: (id: string) => void) => HTMLElement,
 *   renderDetail: (model: ExperimentModel, selectedId: string) => HTMLElement,
 *   renderNoMatches: () => HTMLElement
 * }} renderers
 * @returns {HTMLElement}
 */
export function renderExperimentDecisionSurfaceSection(section, renderers) {
  if (section === 'overview') return renderers.renderOverview(renderers.experiments);
  if (section === 'table') {
    return renderers.renderTable(renderers.experiments, renderers.selectedExperiment, renderers.onSelect);
  }
  if (section === 'detail') {
    return renderers.experiments.length === 0
      ? renderers.renderNoMatches()
      : renderers.renderDetail(renderers.model, renderers.selectedExperiment);
  }
  return renderers.renderNoMatches();
}

/** @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources @returns {ExperimentModel} */
export function buildExperimentDecisionModel(sources) {
  const experimentRows = rowsFor(sources, 'experiments');
  const assignments = rowsFor(sources, 'experiment-assignments');
  const graderDefinitions = rowsFor(sources, 'graders');
  const evalDefinitions = rowsFor(sources, 'evals');
  const runs = rowsFor(sources, 'runs');
  /** @type {Map<string, Row>} */
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

/**
 * @param {Row} row
 * @param {Map<string, Row>} assignmentByRun
 * @param {Row|undefined} definition
 * @param {'grader'|'eval'} sourceType
 * @returns {Row}
 */
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
    evidenceLink: safeExperimentLink(row['evidence-link']) || safeExperimentLink(row['grader-link']) || safeExperimentLink(row['eval-link'])
  };
}

/**
 * @param {{ id: string, definition: Row, assignments: Row[], graders: Row[], evals: Row[] }} input
 * @returns {Row}
 */
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
    primaryId: primaryId || '—',
    primarySource: primary[0]?.sourceType || text(definition['primary-source']) || '—',
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

/** @param {unknown} value */
function normalizeEvalResult(value) {
  const result = upper(value || 'UNKNOWN');
  return ['YES', 'NO', 'UNKNOWN'].includes(result) ? result : 'UNKNOWN';
}

/** @param {Row} row */
function includedObservation(row) {
  if (row.included === false || text(row.included).toLowerCase() === 'no') return false;
  if (row['exclusion-reason']) return false;
  const status = upper(row.status || 'complete');
  return !['MISSING', 'EXCLUDED', 'UNAVAILABLE', 'ERROR', 'FAILED'].includes(status);
}

/** @param {Row} assignment */
function includedAssignment(assignment) {
  if (assignment.included === false || text(assignment.included).toLowerCase() === 'no') return false;
  return !text(assignment['exclusion-reason']);
}

/** @param {unknown} value */
function upper(value) {
  return text(value).replaceAll('-', '_').replaceAll(' ', '_').toUpperCase();
}

/** @param {string} readiness */
function readinessLabel(readiness) {
  if (readiness === 'READY') return 'Strong';
  if (readiness === 'COLLECTING') return 'Collecting';
  return 'Limited';
}

/**
 * @param {ExperimentSummary[]} rows
 * @param {string} key
 * @returns {string[]}
 */
function distinct(rows, key) {
  return [...new Set(rows.map((row) => text(row[key])).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/** @param {string} range */
function rangeStart(range) {
  if (!range || range === 'all') return '';
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString();
}

/**
 * @param {ExperimentModel} model
 * @returns {ExperimentFilters}
 */
export function initialExperimentFilters(model) {
  const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
  const hash = win?.location?.hash || '';
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const filters = /** @type {ExperimentFilters} */ ({
    organization: params.get('organization') || '',
    repository: params.get('repository') || '',
    package: params.get('package') || '',
    workflow: params.get('workflow') || '',
    experiment: params.get('experiment') || '',
    state: params.get('state') || '',
    variant: params.get('variant') || '',
    source: params.get('source') || '',
    metric: params.get('metric') || '',
    range: params.get('range') || '30d'
  });
  if (!filters.experiment && model.experiments[0]?.id) filters.experiment = model.experiments[0].id;
  return filters;
}

/**
 * @param {ExperimentModel} model
 * @param {ExperimentFilters} filters
 * @param {() => void} onChange
 * @returns {HTMLElement}
 */
export function renderExperimentFilters(model, filters, onChange) {
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
    ...controls.map(([key, label, values]) =>
      h(
        'label',
        null,
        h('span', null, label),
        h(
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
        )
      )
    ),
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
        ...[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['all', 'All recorded']]
          .map(([value, label]) => h('option', { value, selected: filters.range === value }, label))
      )
    )
  );
}

/**
 * @param {ExperimentSummary[]} experiments
 * @param {ExperimentFilters} filters
 * @returns {ExperimentSummary[]}
 */
export function filterExperimentRows(experiments, filters) {
  const since = rangeStart(filters.range);
  const sinceTime = since ? Date.parse(since) : NaN;
  return experiments.filter((experiment) => {
    if (filters.organization && experiment.organization !== filters.organization) return false;
    if (filters.repository && experiment.repository !== filters.repository) return false;
    if (filters.package && experiment.package !== filters.package) return false;
    if (filters.workflow && experiment.workflow !== filters.workflow) return false;
    if (filters.experiment && experiment.id !== filters.experiment) return false;
    if (filters.state && experiment.readiness !== filters.state) return false;
    if (filters.variant && ![experiment.control, experiment.candidate].includes(filters.variant)) return false;
    if (filters.source && !experiment.observations.some((/** @type {Row} */ observation) => observation.sourceType === filters.source)) return false;
    if (filters.metric && !experiment.observations.some((/** @type {Row} */ observation) => observation.identifier === filters.metric)) return false;
    if (!Number.isNaN(sinceTime) && experiment.lastObservation) {
      const obsTime = Date.parse(experiment.lastObservation);
      if (!Number.isNaN(obsTime) && obsTime < sinceTime) return false;
    }
    return true;
  });
}

/**
 * @param {ExperimentFilters} filters
 * @param {string} selectedExperiment
 * @param {string} pageId
 */
export function syncExperimentDecisionDeepLink(filters, selectedExperiment, pageId) {
  const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
  if (!win || !win.location || !['http:', 'https:'].includes(win.location.protocol)) return;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && !(key === 'experiment' && selectedExperiment)) params.set(key, value);
  }
  if (selectedExperiment) {
    params.set('experiment', selectedExperiment);
  }
  const query = params.toString();
  win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}#page-${encodeURIComponent(pageId)}${query ? `?${query}` : ''}`);
}

/** @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources @returns {HTMLElement} */
export function renderExperimentDecisionEmptyState(sources) {
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
