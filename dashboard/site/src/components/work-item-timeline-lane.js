import { h } from '../dom.js';
import { renderIconSpan } from './ui-primitives.js';
import { clampPercent } from './count-formatters.js';

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   owner: string,
 *   repository: string,
 *   safeOutputKind?: string,
 *   actor?: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   state: string,
 *   startTime: number,
 *   stopTime: number,
 *   pointInTime?: boolean
 * }} item
 * @param {{ start: number, duration: number }} extents
 * @param {number} [index]
 * @param {number} [divisions]
 * @returns {HTMLElement}
 */
export function renderWorkItemTimelineLane(item, extents, index = 0, divisions = 8) {
  const startOffset = extents.duration > 0 ? ((item.startTime - extents.start) / extents.duration) * 100 : 0;
  const itemDuration = Math.max(item.stopTime - item.startTime, 60_000);
  const width = extents.duration > 0 ? Math.max(8, (itemDuration / extents.duration) * 100) : 100;
  const barStyle = `--work-start: ${clampPercent(startOffset).toFixed(2)}%; --work-width: ${Math.min(100, width).toFixed(2)}%;`;
  const actor = actorLabel(item.actor);
  return h(
    'article',
    { className: 'work-roadmap-lane' },
    h('div', { className: 'work-roadmap-label' },
      h('span', { className: 'work-roadmap-index' }, String(index + 1)),
      renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
      h('span', { className: 'work-roadmap-label-copy' },
        h('strong', null, item.name),
        h('small', null, `${item.repository} · ${item.owner}`)
      )
    ),
    h('div', {
      className: 'work-roadmap-track',
      style: `--roadmap-divisions: ${Math.max(1, divisions)};`
    },
      h('span', {
        className: `work-roadmap-bar${item.pointInTime ? ' work-roadmap-point' : ''} work-state-${item.state}`,
        style: barStyle,
        title: item.pointInTime
          ? `${item.name}: observed ${item.startedLabel}`
          : `${item.name}: ${item.startedLabel} to ${item.stoppedLabel}`
      },
      h('span', {
        className: 'work-roadmap-primitive',
        title: safeOutputLabel(item.safeOutputKind),
        'aria-label': `Safe output: ${safeOutputLabel(item.safeOutputKind)}`
      }, renderIconSpan('work-roadmap-primitive-icon', safeOutputIcon(item.safeOutputKind), { ariaHidden: true })),
      h('strong', { className: 'work-roadmap-bar-title' }, item.name),
      h('span', { className: 'work-roadmap-actor', title: `Involved actor: ${actor}` },
        h('span', { className: 'work-roadmap-avatar', 'aria-hidden': 'true' }, actorInitial(actor)),
        h('span', { className: 'work-roadmap-owner' }, actor)
      )
      ),
      item.pointInTime ? null : h('span', {
        className: `work-roadmap-end work-state-${item.state}`,
        style: `--work-stop: ${clampPercent(startOffset + width).toFixed(2)}%;`,
        'aria-hidden': 'true'
      })
    )
  );
}

/** @param {string | undefined} kind */
function safeOutputIcon(kind) {
  return {
    'pull-request': 'git-pull-request',
    issue: 'issue-opened',
    label: 'tag',
    noop: 'check-circle',
    'review-bundle': 'file',
    report: 'file'
  }[kind || ''] || 'workflow';
}

/** @param {string | undefined} kind */
function safeOutputLabel(kind) {
  return {
    'pull-request': 'Pull request',
    issue: 'Issue',
    label: 'Label',
    noop: 'No-op',
    'review-bundle': 'Review bundle',
    report: 'Report',
    'workflow-output': 'Workflow output'
  }[kind || ''] || 'Workflow output';
}

/** @param {string | undefined} actor */
function actorInitial(actor) {
  return (actor || '?').trim().charAt(0).toUpperCase() || '?';
}

/** @param {string | undefined} actor */
function actorLabel(actor) {
  const value = (actor || '').trim();
  return value && value !== 'unknown' ? value : 'Unassigned';
}
