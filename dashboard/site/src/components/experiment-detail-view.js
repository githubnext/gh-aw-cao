import { h } from '../dom.js'
import { renderExperimentBadge } from './badge.js'
import { renderExperimentDetailSection } from './experiment-detail-sections.js'
import { decisionTone, metricSummaries } from './experiment-view-primitives.js'

/**
 * @param {{ experiments: Array<Record<string, any>>, runById: Map<string, Record<string, any>> }} model
 * @param {string} experimentId
 * @returns {HTMLElement}
 */
export function renderExperimentDetailView(model, experimentId) {
  const experiment = model.experiments.find(
    (candidate) => candidate.id === experimentId,
  )
  if (!experiment) return h('div')
  const metrics = metricSummaries(
    experiment.observations,
    experiment.control,
    experiment.candidate,
  )
  const evalMetrics = metrics.filter((metric) => metric.sourceType === 'eval')
  const graderRegressions = metrics
    .filter((metric) => metric.sourceType === 'grader' && metric.regression)
    .sort((left, right) => left.normalizedEffect - right.normalizedEffect)
  return h(
    'div',
    {
      className: 'experiment-detail',
      'data-selected-experiment': experiment.id,
    },
    h(
      'div',
      { className: 'experiment-selection-heading' },
      h(
        'div',
        null,
        h('span', null, 'Selected experiment'),
        h('h2', null, experiment.name),
      ),
      renderExperimentBadge(
        experiment.decision,
        decisionTone(experiment.decision),
      ),
    ),
    renderExperimentDetailSection('metric-comparison', { metrics, experiment }),
    renderExperimentDetailSection('eval-outcomes', {
      metrics: evalMetrics,
      experiment,
    }),
    renderExperimentDetailSection('grader-diagnostics', {
      metrics: graderRegressions,
    }),
    renderExperimentDetailSection('observation-quality', { experiment }),
    renderExperimentDetailSection('run-evidence', { model, experiment }),
  )
}
