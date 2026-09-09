import { h } from '../dom.js'
import { renderExperimentBadge } from './badge.js'
import { renderExperimentSectionHeading, renderExperimentEffect, decisionTone, formatExperimentDate, sourceMetricLabel } from './experiment-view-primitives.js'

const UNKNOWN = '—'

/**
 * @param {any[]} experiments
 * @param {string} selectedId
 * @param {(id: string) => void} onSelect
 * @returns {HTMLElement}
 */
export function renderExperimentTableView(experiments, selectedId, onSelect) {
  return h(
    'section',
    {
      className: 'experiment-section',
      'aria-labelledby': 'experiment-decisions-title',
    },
    renderExperimentSectionHeading('experiment-decisions-title', 'Experiment decisions', 'Guardrail failures and decision-ready experiments are shown first.'),
    h(
      'div',
      { className: 'table-region experiment-table-region' },
      h(
        'table',
        { className: 'experiment-decision-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...[
              'Experiment',
              'Workflow / agent',
              'Variants',
              'Primary metric',
              'Usable samples',
              'Effect',
              'Evidence',
              'Guardrails',
              'Readiness',
              'Decision',
              'Last observation',
            ].map((label) => h('th', { scope: 'col' }, label)),
          ),
        ),
        h(
          'tbody',
          null,
          ...experiments.map((experiment) =>
            h(
              'tr',
              {
                className: experiment.id === selectedId ? 'selected' : '',
                'aria-selected': String(experiment.id === selectedId),
              },
              h('th', { scope: 'row' }, h('button', { type: 'button', onclick: () => onSelect(experiment.id) }, experiment.name)),
              h('td', null, experiment.workflow || UNKNOWN),
              h('td', null, `${experiment.control} → ${experiment.candidate}`),
              h('td', null, sourceMetricLabel(experiment.primarySource, experiment.primaryId)),
              h(
                'td',
                null,
                `${experiment.controlN} / ${experiment.candidateN}`,
                experiment.excluded ? h('small', null, `${experiment.excluded} excluded`) : null,
              ),
              h('td', null, renderExperimentEffect(experiment.normalizedEffect)),
              h('td', null, experiment.evidenceStrength),
              h(
                'td',
                null,
                experiment.guardrailCount === 0
                  ? renderExperimentBadge('Not configured', 'neutral')
                  : renderExperimentBadge(
                      `${experiment.guardrailCount - experiment.regressingGuardrails.length}/${experiment.guardrailCount} passing`,
                      experiment.regressingGuardrails.length ? 'danger' : 'success',
                    ),
              ),
              h('td', null, renderExperimentBadge(experiment.readiness, experiment.readiness === 'READY' ? 'success' : 'attention')),
              h('td', null, renderExperimentBadge(experiment.decision, decisionTone(experiment.decision))),
              h('td', null, formatExperimentDate(experiment.lastObservation)),
            ),
          ),
        ),
      ),
    ),
  )
}
