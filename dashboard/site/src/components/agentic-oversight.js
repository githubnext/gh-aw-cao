/**
 * Mobile-first primitives for oversight of delegated work.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { renderPageSection, renderViewSectionChrome } from './view-chrome.js';
import { rowsFor as rowsForSource } from './source-rows.js';

const POSITIVE_STATES = new Set(['accepted', 'complete', 'completed', 'durable', 'executed', 'mature', 'matured', 'observed', 'passed', 'produced', 'resolved', 'success', 'verified']);
const NEGATIVE_STATES = new Set(['blocked', 'conflict', 'contended', 'contradicts', 'failed', 'failure', 'rejected', 'unsupported']);
const PENDING_STATES = new Set(['active', 'annotated', 'derived', 'in-progress', 'inferred', 'interim', 'partial', 'pending', 'proposal', 'review', 'running', 'waiting']);

/**
 * @typedef {{
 *   pageId: string,
 *   title: string,
 *   description?: string,
 *   sourceNames: string[],
 *   sources: Record<string, import('../presenter.js').LogicalSourceInput>,
 *   contextDetails: string[],
 *   headingTag: 'h3'|'h4'
 * }} OversightContext
 */

/** @type {Map<string, (context: OversightContext) => HTMLElement>} */
export const AGENTIC_OVERSIGHT_RENDERERS = new Map([
  ['attention-stack', renderAttentionStack],
  ['work-list', renderWorkList],
  ['outcome-list', renderOutcomeList],
  ['truth-rail', renderTruthRailElement],
  ['state-summary', renderStateSummary],
  ['state-ribbon', renderStateRibbonElement],
  ['agent-assignment-list', renderAgentAssignmentList],
  ['coordination-braid', renderCoordinationBraidElement],
  ['evidence-list', renderEvidenceList],
  ['evidence-split', renderEvidenceSplitElement],
  ['provenance-spine', renderProvenanceSpineElement],
  ['maturity-horizon', renderMaturityHorizon],
  ['capacity-horizon', renderCapacityHorizon],
  ['operational-pulse', renderOperationalPulse]
]);

export const AGENTIC_OVERSIGHT_EMPTY_AWARE_ELEMENTS = new Set([
  'attention-stack',
  'work-list',
  'outcome-list',
  'agent-assignment-list',
  'evidence-list',
  'maturity-horizon',
  'capacity-horizon',
  'operational-pulse'
]);

/** @param {OversightContext} context */
function renderAttentionStack(context) {
  const rows = rankedRows(context, context.sourceNames[0], 'priority').filter((row) => {
    const recovery = text(row['recovery-state']).toLowerCase();
    const signal = text(row['signal-type']).toLowerCase();
    return !row['resolved-at'] && recovery !== 'autonomous' && !['recovered', 'resolved'].includes(signal);
  });
  const content = rows.length === 0
    ? h('p', { className: 'oversight-empty', role: 'status' }, 'Nothing currently needs human attention.')
    : h(
        'ol',
        { className: 'attention-stack', 'aria-label': `${rows.length} unresolved attention items` },
        ...rows.map((row, index) => {
          const link = evidenceLink(row);
          const age = finiteNumber(row['age-seconds']);
          const detail = h(
            'div',
            { className: 'attention-stack-copy' },
            h('span', { className: 'oversight-kicker' }, humanize(row['signal-type']) || 'Needs review'),
            h('strong', null, text(row.objective) || 'Unidentified work'),
            text(row.scope) ? h('small', null, text(row.scope)) : null,
            h('p', null, text(row.reason) || 'Reason unavailable'),
            h(
              'div',
              { className: 'oversight-meta' },
              text(row['expected-actor']) ? h('span', null, `Waiting on ${text(row['expected-actor'])}`) : null,
              age !== null ? h('span', null, `Waiting ${formatClockDuration(age * 1000)}`) : null,
              text(row['consequence']) ? h('span', null, text(row['consequence'])) : null
            )
          );
          const action = h(
            'span',
            { className: 'oversight-action' },
            text(row.action) || 'Investigate',
            octicon('arrow-right')
          );
          return h(
            'li',
            { className: `attention-stack-item${index === 0 ? ' attention-stack-primary' : ''}` },
            link
              ? h('a', { href: link.href, 'aria-label': `${text(row.action) || 'Investigate'}: ${text(row.objective)}` }, detail, action)
              : h('div', null, detail, action)
          );
        })
      );
  return section(context, content);
}

/** @param {OversightContext} context */
function renderWorkList(context) {
  const sourceRows = [...rowsFor(context, context.sourceNames[0])].sort(compareWorkPriority);
  const rows = context.pageId === 'home'
    ? sourceRows.filter((row) => !['completed', 'cancelled'].includes(text(row['lifecycle-state']).toLowerCase())).slice(0, 5)
    : sourceRows;
  return section(context, h(
    'div',
    { className: 'oversight-list work-list', 'aria-label': 'Delegated work' },
    ...(rows.length > 0
      ? rows.map((row) => renderWorkCard(row, rows))
      : [h('p', { className: 'oversight-empty' }, 'No active work items were observed in the selected scope.')]),
    rows.length > 0 ? renderDataDisclosure(rows, [
      ['objective', 'Work'],
      ['scope', 'Scope'],
      ['lifecycle-state', 'State'],
      ['phase', 'Phase'],
      ['reason', 'Why'],
      ['next-action', 'Next action'],
      ['waiting-on', 'Waiting on'],
      ['owner', 'Owner']
    ]) : null
  ));
}

/** @param {Record<string, unknown>} row @param {Array<Record<string, unknown>>} allRows */
function renderWorkCard(row, allRows) {
  const link = evidenceLink(row);
  const state = text(row['lifecycle-state'] || row.phase || 'unknown');
  const details = h(
    'details',
    { className: 'oversight-detail' },
    h('summary', null, 'Inspect state and evidence'),
    renderStateRibbon(row),
    renderTruthRail(row),
    renderDefinitionRows([
      ['Evidence', text(row['reason-evidence-class']) || 'Unavailable'],
      ['Owner', text(row.owner) || 'Unavailable'],
      ['Waiting on', text(row['waiting-on']) || 'Not waiting']
    ])
  );
  return h(
    'article',
    {
      className: 'oversight-card work-card',
      'data-filter-field': 'lifecycle-state',
      'data-filter-value': state.toLowerCase()
    },
    h('header', null,
      h('div', null, h('strong', null, text(row.objective) || 'Unidentified work'), text(row.scope) ? h('small', null, text(row.scope)) : null),
      renderStateLabel(state)
    ),
    h('p', { className: 'oversight-reason' }, text(row.reason) || 'Reason unavailable'),
    renderTruthRail(row, true),
    h('div', { className: 'oversight-next' },
      h('span', null, h('small', null, 'Next'), h('strong', null, text(row['next-action']) || 'Inspect current state')),
      link ? h('a', { href: link.href, 'aria-label': `${text(row['next-action']) || 'Inspect'}: ${text(row.objective)}` }, octicon('arrow-right')) : null
    ),
    details,
    allRows.length > 1 ? null : h('span', { className: 'sr-only' }, 'Only work item in the current view')
  );
}

/** @param {OversightContext} context */
function renderOutcomeList(context) {
  const sourceRows = [...rowsFor(context, context.sourceNames[0])].sort((left, right) =>
    Date.parse(text(right['observed-at'])) - Date.parse(text(left['observed-at']))
  );
  const rows = context.pageId === 'home' ? sourceRows.slice(0, 5) : sourceRows;
  return section(context, h(
    'div',
    { className: 'oversight-list outcome-list', 'aria-label': 'Recent outcomes' },
    ...(rows.length > 0 ? rows.map((row) => {
      const link = evidenceLink(row);
      const state = text(row['outcome-state'] || row['outcome-status'] || 'pending');
      const card = h(
        'article',
        { className: 'outcome-strip' },
        h('div', null,
          h('strong', null, text(row['outcome-title'] || row['safe-output']) || 'Untitled outcome'),
          h('small', null, [text(row.repository), text(row['outcome-category'])].filter(Boolean).join(' · '))
        ),
        renderStateLabel(state),
        h('div', { className: 'outcome-strip-meta' },
          h('span', null, `Artifact ${text(row['artifact-state']) || 'produced'}`),
          h('span', null, `Maturity ${text(row['maturity-status']) || 'unavailable'}`),
          h('time', { datetime: text(row['observed-at']) }, text(row['observed-at']) || 'Observation unavailable')
        ),
        renderTruthRail({
          'execution-state': text(row['run-conclusion']) || 'unknown',
          'verification-state': text(row['verification-state']) || 'unavailable',
          'outcome-state': state,
          'maturity-status': text(row['maturity-status']) || 'unavailable'
        }, true),
        link ? h('a', { className: 'outcome-strip-link', href: link.href, 'aria-label': `Inspect outcome: ${text(row['outcome-title'])}` }, 'Inspect', octicon('arrow-right')) : null
      );
      return card;
    }) : [h('p', { className: 'oversight-empty' }, 'No outcomes were retained in the selected scope.')]),
    rows.length > 0 ? renderDataDisclosure(rows, [
      ['outcome-title', 'Outcome'],
      ['repository', 'Repository'],
      ['outcome-state', 'Disposition'],
      ['maturity-status', 'Maturity'],
      ['observed-at', 'Observed']
    ]) : null
  ));
}

/** @param {OversightContext} context */
function renderStateSummary(context) {
  const rows = rowsFor(context, context.sourceNames[0]);
  const sourceName = context.sourceNames[0];
  const field = sourceName === 'agent-assignments' ? 'agent-state' : sourceName === 'evidence-records' ? 'evidence-class' : 'lifecycle-state';
  const preferredOrder = field === 'lifecycle-state'
    ? ['active', 'waiting', 'review', 'blocked', 'completed', 'cancelled', 'unknown']
    : field === 'agent-state'
      ? ['active', 'working', 'waiting', 'pending', 'idle', 'blocked', 'unknown']
      : ['observed', 'derived', 'annotated', 'inferred', 'unsupported', 'unknown'];
  const counts = new Map();
  for (const row of rows) {
    const state = text(row[field] || 'unknown').toLowerCase();
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const entries = [...counts].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left[0]);
    const rightIndex = preferredOrder.indexOf(right[0]);
    return (leftIndex < 0 ? preferredOrder.length : leftIndex) - (rightIndex < 0 ? preferredOrder.length : rightIndex);
  });
  const max = Math.max(1, ...entries.map(([, count]) => count));
  const coordinationIssues = sourceName === 'agent-assignments'
    ? rows.filter((row) =>
        (text(row['conflict-state']) && text(row['conflict-state']) !== 'none')
        || ['waiting', 'blocked'].includes(text(row['dependency-state']).toLowerCase())
      ).length
    : 0;
  const metadata = context.sources[sourceName]?.metadata;
  const list = h(
    'div',
    { className: 'state-summary', 'aria-label': `${context.title}: ${rows.length} total` },
    sourceName === 'agent-assignments'
      ? h('p', { className: 'state-summary-context' }, h('strong', null, `${rows.length} agents`), ` · ${coordinationIssues} coordination ${coordinationIssues === 1 ? 'issue' : 'issues'}`)
      : sourceName === 'evidence-records'
        ? h('p', { className: 'state-summary-context' }, `Availability ${text(metadata?.availability) || 'unknown'} · completeness ${text(metadata?.completeness) || 'unknown'} · freshness ${text(metadata?.freshness) || 'unknown'}`)
        : null,
    ...entries.map(([state, count]) => {
      const button = h(
        'button',
        {
          type: 'button',
          className: `state-summary-row state-${semanticState(state)}`,
          'aria-pressed': 'false',
          'aria-label': `Filter by ${humanize(state)}, ${count}`
        },
        h('span', null, humanize(state)),
        h('strong', null, String(count)),
        h('span', { className: 'state-summary-track', 'aria-hidden': 'true' },
          h('i', { style: `--state-quantity:${(count / max) * 100}%` })
        )
      );
      button.addEventListener('click', () => applyStateFilter(button, field, state));
      return button;
    }),
    entries.length === 0 ? h('p', { className: 'oversight-empty' }, 'No states are available.') : null
  );
  return section(context, list);
}

/** @param {HTMLElement} button @param {string} field @param {string} state */
function applyStateFilter(button, field, state) {
  const page = button.closest('[data-page-id]');
  if (!(page instanceof HTMLElement)) return;
  const wasPressed = button.getAttribute('aria-pressed') === 'true';
  for (const candidate of page.querySelectorAll('.state-summary-row')) candidate.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-pressed', String(!wasPressed));
  for (const card of page.querySelectorAll(`[data-filter-field="${field}"]`)) {
    if (card instanceof HTMLElement) card.hidden = !wasPressed && card.dataset.filterValue !== state;
  }
}

/** @param {OversightContext} context */
function renderAgentAssignmentList(context) {
  const rows = rowsFor(context, context.sourceNames[0]);
  const grouped = groupRows(rows, 'work-item-id');
  return section(context, h(
    'div',
    { className: 'oversight-list agent-assignment-list', 'aria-label': 'Agent assignments' },
    ...(rows.length > 0 ? rows.map((row) => {
      const state = text(row['agent-state'] || 'unknown');
      const coordination = grouped.get(text(row['work-item-id'])) ?? [row];
      const exceptions = [
        text(row['handoff-state']) && !['none', 'in-progress', 'completed'].includes(text(row['handoff-state'])) ? `Handoff: ${text(row['handoff-state'])}` : '',
        text(row['dependency-state']) && !['none', 'clear', 'resolved'].includes(text(row['dependency-state'])) ? `Dependency: ${text(row['dependency-state'])}` : '',
        text(row['conflict-state']) && text(row['conflict-state']) !== 'none' ? `Conflict: ${text(row['conflict-state'])}` : ''
      ].filter(Boolean);
      return h(
        'article',
        {
          className: 'oversight-card assignment-card',
          'data-filter-field': 'agent-state',
          'data-filter-value': state.toLowerCase()
        },
        h('header', null,
          h('div', null, h('strong', null, text(row['agent-name']) || 'Unknown agent'), h('small', null, text(row.objective) || 'Work unavailable')),
          renderStateLabel(state)
        ),
        exceptions.length > 0
          ? h('ul', { className: 'coordination-exceptions' }, ...exceptions.map((exception) => h('li', null, octicon('alert'), exception)))
          : h('p', { className: 'coordination-clear' }, 'No coordination exception observed.'),
        coordination.length > 1 || exceptions.length > 0
          ? h('details', { className: 'oversight-detail' }, h('summary', null, 'Inspect coordination'), renderCoordinationBraid(coordination))
          : null
      );
    }) : [h('p', { className: 'oversight-empty' }, 'No exact agent-to-work assignments were observed.')]),
    rows.length > 0 ? renderDataDisclosure(rows, [
      ['agent-name', 'Agent'],
      ['objective', 'Work'],
      ['agent-state', 'State'],
      ['handoff-state', 'Handoff'],
      ['dependency-state', 'Dependency'],
      ['conflict-state', 'Conflict']
    ]) : null
  ));
}

/** @param {OversightContext} context */
function renderEvidenceList(context) {
  const rows = rowsFor(context, context.sourceNames[0]);
  return section(context, h(
    'div',
    { className: 'oversight-list evidence-list', 'aria-label': 'Claims and evidence' },
    ...(rows.length > 0 ? rows.map((row) => {
      const evidenceClass = text(row['evidence-class'] || 'unknown');
      const related = rows.filter((candidate) => text(candidate['work-item-id']) === text(row['work-item-id']));
      const split = renderEvidenceSplit(related);
      const link = evidenceLink(row);
      return h(
        'article',
        {
          className: 'oversight-card evidence-card',
          'data-filter-field': 'evidence-class',
          'data-filter-value': evidenceClass.toLowerCase()
        },
        h('header', null, h('strong', null, `“${text(row.claim) || text(row.objective) || 'Claim unavailable'}”`), renderStateLabel(evidenceClass)),
        renderDefinitionRows([
          ['Verification', text(row['verification-state']) || 'Unavailable'],
          ['Provenance', text(row['provenance-state']) || 'Unavailable'],
          ['Source', text(row['source-revision'] || row['evidence-kind']) || 'Unavailable'],
          ['Observed', text(row['observed-at']) || 'Unavailable']
        ]),
        h('details', { className: 'oversight-detail' },
          h('summary', null, 'Inspect provenance'),
          renderProvenanceSpine(row),
          split
        ),
        link ? h('a', { className: 'evidence-card-link', href: link.href }, 'Open evidence', octicon('arrow-right')) : null
      );
    }) : [h('p', { className: 'oversight-empty' }, 'No work-oriented evidence records were observed.')]),
    rows.length > 0 ? renderDataDisclosure(rows, [
      ['claim', 'Claim'],
      ['evidence-class', 'Class'],
      ['verification-state', 'Verification'],
      ['provenance-state', 'Provenance'],
      ['source-revision', 'Source'],
      ['observed-at', 'Observed']
    ]) : null
  ));
}

/** @param {OversightContext} context */
function renderMaturityHorizon(context) {
  const outcomes = rowsFor(context, context.sourceNames[0]);
  const values = rowsFor(context, context.sourceNames[1]);
  const content = h(
    'div',
    { className: 'maturity-horizon', 'aria-label': 'Outcome and value maturity over time' },
    ...(outcomes.length > 0 ? outcomes.map((outcome) => {
      const matchingValue = values.find((value) =>
        (!text(outcome.repository) || text(value.repository) === text(outcome.repository))
        && (!text(outcome.workflow) || text(value.workflow) === text(outcome.workflow))
        && (!text(outcome.run) || text(value.run) === text(outcome.run))
      );
      const state = text(outcome['outcome-state'] || 'pending');
      const maturity = text(matchingValue?.['maturity-status'] || outcome['maturity-status'] || 'unavailable');
      return h(
        'article',
        { className: 'maturity-row' },
        h('strong', null, text(outcome['outcome-title'] || outcome['safe-output']) || 'Untitled outcome'),
        renderTruthRail({
          'execution-state': text(outcome['run-conclusion']) || 'unknown',
          'verification-state': text(outcome['verification-state']) || 'unavailable',
          'outcome-state': state,
          'maturity-status': maturity
        }),
        h('small', null, `Observed ${text(outcome['observed-at']) || 'unavailable'} · value ${matchingValue?.['operational-value'] ?? 'unavailable'}`)
      );
    }) : [h('p', { className: 'oversight-empty' }, 'No outcomes were retained in the selected scope.')]),
    outcomes.length > 0 ? renderDataDisclosure(outcomes, [
      ['outcome-title', 'Outcome'],
      ['outcome-state', 'Disposition'],
      ['observed-at', 'Observed']
    ]) : null
  );
  return section(context, content);
}

/** @param {OversightContext} context */
function renderCapacityHorizon(context) {
  const rows = latestRows(rowsFor(context, context.sourceNames[0]), ['credential', 'resource'], 'observed-at');
  return section(context, h(
    'div',
    { className: 'capacity-horizon', 'aria-label': 'GitHub API capacity through reset' },
    ...(rows.length > 0 ? rows.map((row) => {
      const percent = finiteNumber(row['remaining-percent']);
      const risk = text(row['risk-status'] || 'unknown');
      const minutes = finiteNumber(row['minutes-to-reset']);
      const forecast = finiteNumber(row['projected-remaining-at-reset']);
      return h(
        'article',
        { className: `capacity-row state-${semanticState(risk)}` },
        h('header', null, h('strong', null, text(row.resource) || 'Unknown resource'), h('small', null, text(row.credential) || 'Unknown credential')),
        percent === null
          ? h('p', { className: 'capacity-unavailable' }, 'Capacity telemetry unavailable')
          : h('progress', { max: 100, value: Math.max(0, Math.min(100, percent)), 'aria-label': `${text(row.resource)} has ${percent}% capacity remaining` }),
        h('div', { className: 'capacity-meta' },
          h('strong', null, percent === null ? 'Unavailable' : `${percent}%`),
          h('span', null, minutes === null ? 'Reset unavailable' : `resets in ${formatClockDuration(minutes * 60_000)}`)
        ),
        forecast !== null
          ? h('p', { className: risk === 'critical' || risk === 'warning' ? 'capacity-risk' : 'capacity-forecast' },
              risk === 'critical' || risk === 'warning' ? octicon('alert') : null,
              forecast <= 0 ? 'Observed burn may exhaust before reset' : `${forecast} projected remaining at reset`
            )
          : h('p', { className: 'capacity-forecast' }, 'Forecast unavailable: insufficient qualified history')
      );
    }) : [h('p', { className: 'oversight-empty' }, 'Capacity telemetry is unavailable; remaining capacity is not assumed to be zero.')]),
    rows.length > 0 ? renderDataDisclosure(rows, [
      ['credential', 'Credential'],
      ['resource', 'Resource'],
      ['remaining', 'Remaining'],
      ['remaining-percent', 'Remaining %'],
      ['reset-at', 'Reset'],
      ['risk-status', 'Status']
    ]) : null
  ));
}

/** @param {OversightContext} context */
function renderOperationalPulse(context) {
  const work = rowsFor(context, context.sourceNames[0]);
  const evidenceSource = context.sources[context.sourceNames[1]];
  const outcomes = rowsFor(context, context.sourceNames[2]);
  const values = rowsFor(context, context.sourceNames[3]);
  const capacity = latestRows(rowsFor(context, context.sourceNames[4]), ['credential', 'resource'], 'observed-at');
  const usage = rowsFor(context, context.sourceNames[5]);
  /** @param {string[]} states */
  const count = (states) => work.filter((row) => states.includes(text(row['lifecycle-state']).toLowerCase())).length;
  const verificationNeedsReview = work.filter((row) => NEGATIVE_STATES.has(text(row['verification-state']).toLowerCase())).length;
  const pendingOutcomes = outcomes.filter((row) => text(row['outcome-state']).toLowerCase() === 'pending').length;
  const matureValues = values.filter((row) => text(row['maturity-status']).toLowerCase() === 'matured').length;
  const capacityRisks = capacity.filter((row) => ['critical', 'warning'].includes(text(row['risk-status']).toLowerCase())).length;
  const measuredAic = usage.reduce((sum, row) => sum + (finiteNumber(row.aic) ?? 0), 0);
  return section(context, h(
    'div',
    { className: 'operational-pulse', role: 'status', 'aria-label': 'Operational pulse' },
    h('div', null,
      h('span', null, h('strong', null, String(count(['active', 'review']))), ' active'),
      h('span', null, h('strong', null, String(count(['waiting']))), ' waiting'),
      h('span', null, h('strong', null, String(count(['blocked']))), ' blocked'),
      h('span', null, `verification: ${verificationNeedsReview} need review`)
    ),
    h('dl', { className: 'operational-pulse-dimensions' },
      h('div', null, h('dt', null, 'Outcomes'), h('dd', null, `${pendingOutcomes} pending`)),
      h('div', null, h('dt', null, 'Value'), h('dd', null, values.length > 0 ? `${matureValues}/${values.length} mature` : 'unavailable')),
      h('div', null, h('dt', null, 'Evidence'), h('dd', null, `${text(evidenceSource?.metadata?.freshness) || 'unknown'} · ${text(evidenceSource?.metadata?.completeness) || 'unknown'}`)),
      h('div', null, h('dt', null, 'Capacity'), h('dd', null, capacity.length > 0 ? `${capacityRisks} at risk` : 'unavailable')),
      h('div', null, h('dt', null, 'Measured cost'), h('dd', null, usage.length > 0 ? `${measuredAic} AIC` : 'unavailable'))
    )
  ));
}

/** @param {OversightContext} context */
function renderTruthRailElement(context) {
  return section(context, renderTruthRail(rowsFor(context, context.sourceNames[0])[0] ?? {}));
}

/** @param {OversightContext} context */
function renderStateRibbonElement(context) {
  return section(context, renderStateRibbon(rowsFor(context, context.sourceNames[0])[0] ?? {}));
}

/** @param {OversightContext} context */
function renderCoordinationBraidElement(context) {
  return section(context, renderCoordinationBraid(rowsFor(context, context.sourceNames[0])));
}

/** @param {OversightContext} context */
function renderEvidenceSplitElement(context) {
  return section(context, renderEvidenceSplit(rowsFor(context, context.sourceNames[0])) ?? h('p', { className: 'oversight-empty' }, 'No contradictory evidence observed.'));
}

/** @param {OversightContext} context */
function renderProvenanceSpineElement(context) {
  return section(context, renderProvenanceSpine(rowsFor(context, context.sourceNames[0])[0] ?? {}));
}

/** @param {Record<string, unknown>} row @param {boolean} [compact] */
export function renderTruthRail(row, compact = false) {
  const stages = [
    ['Executed', row['execution-state'] ?? row['run-conclusion'] ?? row.phase],
    ['Verified', row['verification-state']],
    ['Outcome', row['outcome-state']],
    ['Mature', row['maturity-status'] ?? row['value-state']]
  ];
  return h(
    'ol',
    {
      className: `truth-rail${compact ? ' truth-rail-compact' : ''}`,
      'aria-label': stages.map(([label, value]) => `${label}: ${text(value) || 'unavailable'}`).join('; ')
    },
    ...stages.map(([label, value]) => {
      const state = text(value) || 'unavailable';
      return h('li', { className: `state-${semanticState(state)}` },
        h('span', { className: 'truth-rail-node', 'aria-hidden': 'true' }, stateSymbol(state)),
        h('span', null, h('strong', null, label), h('small', null, humanize(state)))
      );
    })
  );
}

/** @param {Record<string, unknown>} row */
export function renderStateRibbon(row) {
  const history = Array.isArray(row['state-history']) && row['state-history'].length > 0
    ? row['state-history'].filter(isObject)
    : [{ phase: row.phase || row['lifecycle-state'] || 'unknown', 'observed-at': row['observed-at'], reason: row.reason }];
  return h(
    'ol',
    { className: 'state-ribbon', 'aria-label': 'Evidence-backed state history' },
    ...history.map((entry) => {
      const phase = text(entry.phase || entry.state || 'unknown');
      const observed = text(entry['observed-at'] || entry.start);
      const ended = text(entry['ended-at'] || entry.end);
      const inferred = text(entry['transition-kind']).toLowerCase() === 'inferred' || entry.inferred === true;
      const waiting = phase.toLowerCase().includes('wait');
      return h(
        'li',
        { className: `${waiting ? 'state-ribbon-waiting ' : ''}${inferred ? 'state-ribbon-inferred' : 'state-ribbon-observed'}`.trim() },
        h('details', null,
          h('summary', null, h('strong', null, humanize(phase)), h('small', null, inferred ? 'Inferred' : 'Observed')),
          h('p', null, text(entry.reason) || 'Transition reason unavailable'),
          h('time', { datetime: observed }, observed || 'Start unavailable'),
          waiting ? h('span', null, ` → ${ended || 'end unavailable'}`) : null
        )
      );
    })
  );
}

/** @param {Array<Record<string, unknown>>} rows */
export function renderCoordinationBraid(rows) {
  const ordered = [...rows].sort((left, right) => Date.parse(text(left['started-at'] || left['observed-at'])) - Date.parse(text(right['started-at'] || right['observed-at'])));
  return h(
    'div',
    { className: 'coordination-braid', 'aria-label': 'Ordered agent handoffs on a monotonic time axis' },
    h('p', { className: 'coordination-axis', 'aria-hidden': 'true' }, 'time ', '────────────────────────→'),
    h('ol', null, ...ordered.map((row, index) => {
      const conflict = text(row['conflict-state']) && text(row['conflict-state']) !== 'none';
      const source = text(row['coordination-source'] || row['topology-kind'] || 'observed');
      return h('li', { className: conflict ? 'coordination-conflict' : '' },
        h('strong', null, text(row['agent-name']) || 'Unknown agent'),
        h('span', { className: 'coordination-segment', 'aria-hidden': 'true' }, '━━━━━━', index < ordered.length - 1 ? '↓' : '●'),
        h('small', null, `${humanize(text(row['handoff-state']) || 'assigned')} · ${humanize(source)}`),
        text(row['ended-at']) || text(row['observed-at']) ? null : h('em', null, 'boundary unavailable'),
        conflict ? h('span', { className: 'coordination-warning' }, octicon('alert'), ` ${text(row['conflict-state'])}`) : null
      );
    }))
  );
}

/** @param {Array<Record<string, unknown>>} rows */
export function renderEvidenceSplit(rows) {
  const supports = rows.filter((row) => evidenceDisposition(row) === 'supports');
  const contradicts = rows.filter((row) => evidenceDisposition(row) === 'contradicts');
  if (supports.length === 0 || contradicts.length === 0) return null;
  /**
   * @param {string} title
   * @param {Array<Record<string, unknown>>} items
   * @param {'supports'|'contradicts'} tone
   */
  const column = (title, items, tone) => h(
    'section',
    { className: `evidence-split-column evidence-split-${tone}`, 'aria-label': title },
    h('h4', null, title),
    h('ul', null, ...items.map((row) => h('li', null,
      octicon(tone === 'supports' ? 'check' : 'x'),
      h('span', null, h('strong', null, text(row['evidence-kind'] || row.claim) || 'Evidence'), h('small', null, `${text(row['evidence-class']) || 'unknown'} · ${text(row['source-revision']) || 'source unavailable'}`))
    )))
  );
  return h('div', { className: 'evidence-split', role: 'group', 'aria-label': 'Contradictory evidence remains unresolved' },
    column('Supports', supports, 'supports'),
    column('Contradicts', contradicts, 'contradicts'),
    h('strong', { className: 'evidence-unresolved' }, 'Unresolved')
  );
}

/** @param {Record<string, unknown>} row */
export function renderProvenanceSpine(row) {
  /** @type {Array<[string, unknown]>} */
  const nodes = [
    ['Authority', row.authority ?? row['authority-state']],
    ['Objective', row.objective],
    ['Work', row['work-item-id']],
    ['Execution', row.execution ?? row['source-revision']],
    ['Evidence', row.claim ?? row['evidence-id']],
    ['Artifact', row.artifact ?? row['artifact-state']],
    ['Outcome', row.outcome ?? row['outcome-state']],
    ['Value', row.value ?? row['maturity-status']]
  ];
  return h(
    'ol',
    { className: 'provenance-spine', 'aria-label': 'Provenance from authority to operational value' },
    ...nodes.map(([label, value], index) => {
      const normalized = text(value).toLowerCase();
      const state = value == null || value === '' || ['unavailable', 'unknown'].includes(normalized)
        ? 'unavailable'
        : normalized === 'not-applicable' ? 'not-applicable' : 'available';
      const link = label === 'Evidence' ? evidenceLink(row) : null;
      const valueText = text(value) || `${label.toLowerCase()} association unavailable`;
      return h('li', { className: `provenance-node provenance-${state}` },
        h('span', { className: 'provenance-connector', 'aria-hidden': 'true' }, index === nodes.length - 1 ? '○' : state === 'available' ? '●' : '○'),
        h('span', null,
          h('strong', null, label),
          link ? h('a', { href: link.href }, valueText) : h('small', null, valueText)
        )
      );
    })
  );
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function compareWorkPriority(left, right) {
  const order = ['blocked', 'waiting', 'review', 'active', 'unknown', 'completed', 'cancelled'];
  const leftState = text(left['lifecycle-state']).toLowerCase();
  const rightState = text(right['lifecycle-state']).toLowerCase();
  const stateDifference = (order.indexOf(leftState) < 0 ? order.length : order.indexOf(leftState))
    - (order.indexOf(rightState) < 0 ? order.length : order.indexOf(rightState));
  if (stateDifference !== 0) return stateDifference;
  const timeDifference = Date.parse(text(right['observed-at'])) - Date.parse(text(left['observed-at']));
  return Number.isFinite(timeDifference) && timeDifference !== 0
    ? timeDifference
    : text(left['work-item-id']).localeCompare(text(right['work-item-id']));
}

/** @param {Array<Record<string, unknown>>} rows @param {Array<[string, string]>} columns */
function renderDataDisclosure(rows, columns) {
  return h(
    'details',
    { className: 'view-data-disclosure' },
    h('summary', null, 'View data'),
    h('div', { className: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Tabular data equivalent' },
      h('table', { className: 'oversight-data-table' },
        h('thead', null, h('tr', null, ...columns.map(([, label]) => h('th', { scope: 'col' }, label)))),
        h('tbody', null, ...rows.map((row) => h('tr', null, ...columns.map(([field]) => h('td', null, text(row[field]) || 'Unavailable')))))
      )
    )
  );
}

/** @param {Array<[string, string]>} rows */
function renderDefinitionRows(rows) {
  return h('dl', { className: 'oversight-definition-list' }, ...rows.flatMap(([label, value]) => [
    h('div', null, h('dt', null, label), h('dd', null, value))
  ]));
}

/** @param {OversightContext} context @param {HTMLElement} content */
function section(context, content) {
  const source = context.sources[context.sourceNames[0]];
  return renderPageSection(
    context.pageId,
    context.title,
    [...renderViewSectionChrome(source?.metadata, context.contextDetails), content],
    context.headingTag,
    context.description
  );
}

/** @param {OversightContext} context @param {string} sourceName */
function rowsFor(context, sourceName) {
  return sourceName ? rowsForSource(context.sources, sourceName) : [];
}

/** @param {OversightContext} context @param {string} sourceName @param {string} field */
function rankedRows(context, sourceName, field) {
  return [...rowsFor(context, sourceName)].sort((left, right) => (finiteNumber(left[field]) ?? Number.MAX_SAFE_INTEGER) - (finiteNumber(right[field]) ?? Number.MAX_SAFE_INTEGER));
}

/** @param {Array<Record<string, unknown>>} rows @param {string} field */
function groupRows(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = text(row[field]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

/** @param {Array<Record<string, unknown>>} rows @param {string[]} keys @param {string} timeField */
function latestRows(rows, keys, timeField) {
  const latest = new Map();
  for (const row of rows) {
    const key = keys.map((field) => text(row[field])).join('\u0000');
    const previous = latest.get(key);
    if (!previous || Date.parse(text(row[timeField])) >= Date.parse(text(previous[timeField]))) latest.set(key, row);
  }
  return [...latest.values()];
}

/** @param {Record<string, unknown>} row */
function evidenceLink(row) {
  return findLink(row, 'evidence-link') ?? findLink(row, 'external-link') ?? findLink(row, 'run-link');
}

/** @param {Record<string, unknown>} row */
function evidenceDisposition(row) {
  const explicit = text(row['evidence-disposition']).toLowerCase();
  if (explicit === 'supports' || explicit === 'contradicts') return explicit;
  return ['rejected', 'failed', 'contradicts'].includes(text(row['verification-state']).toLowerCase()) ? 'contradicts' : 'supports';
}

/** @param {string} value */
function semanticState(value) {
  const normalized = value.toLowerCase();
  if (POSITIVE_STATES.has(normalized)) return 'complete';
  if (NEGATIVE_STATES.has(normalized)) return 'failed';
  if (PENDING_STATES.has(normalized)) return 'pending';
  if (normalized === 'not-applicable') return 'not-applicable';
  return 'unavailable';
}

/** @param {string} value */
function stateSymbol(value) {
  const state = semanticState(value);
  return state === 'complete' ? '✓' : state === 'failed' ? '✕' : state === 'pending' ? '◌' : state === 'not-applicable' ? '—' : '?';
}

/** @param {string} state */
function renderStateLabel(state) {
  return h('span', { className: `oversight-state state-${semanticState(state)}` }, stateSymbol(state), ' ', humanize(state));
}

/** @param {unknown} value */
function text(value) {
  return value == null ? '' : String(value);
}

/** @param {unknown} value */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function humanize(value) {
  const normalized = text(value).replace(/[-_]+/g, ' ').trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : '';
}

/** @param {unknown} value */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
