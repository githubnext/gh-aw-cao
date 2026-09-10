import { h } from '../dom.js';
import { renderLinkedValue, renderSafeLink } from './link-content.js';
import { renderIconSpan, renderWorkItemPackageLabel } from './ui-primitives.js';

/** @import { SafeLink } from './link-content.js' */

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   evidenceLink?: SafeLink | null,
 *   repositoryLink?: SafeLink | null,
 *   repository: string,
 *   owner: string,
 *   timeLabel: string,
 *   started: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   state: string,
 *   stateLabel: string,
 *   packageName: string,
 *   workType: string
 * }} item
 * @returns {HTMLElement}
 */
export function renderWorkItemRow(item) {
  return h(
    'article',
    { className: 'work-task-row', role: 'listitem' },
    h('div', { className: 'work-task-main' },
      h('span', { className: 'work-group-chevron-placeholder', 'aria-hidden': 'true' }),
      renderIconSpan('work-task-icon', item.icon, { ariaHidden: true }),
      h('span', { className: 'work-task-title' },
        h('strong', null, renderLinkedValue(item.name, item.evidenceLink ?? null)),
        h('small', null, item.repository)
      )
    ),
    h('span', { className: 'work-task-status-cell' }, h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel)),
    h('span', { className: 'work-task-type' }, item.workType === 'unknown' ? '—' : item.workType),
    h('span', { className: 'work-task-labels' }, renderWorkItemPackageLabel(item.packageName) ?? '—'),
    h('time', { dateTime: item.started, title: item.timeLabel }, item.startedLabel),
    h('span', { className: 'work-task-end' }, item.timeLabel === 'Observed' ? 'Point observation' : item.stoppedLabel),
    renderRepositoryOwner(item.repository, item.repositoryLink)
  );
}

/** @param {string} repository @param {SafeLink | null} [repositoryLink] */
export function renderRepositoryOwner(repository, repositoryLink = null) {
  const content = h('span', { className: 'work-task-repository' },
    renderIconSpan('work-task-repository-icon', 'repo', { ariaHidden: true }),
    h('span', null, repository));
  return h('span', { className: 'work-task-owner', title: repository }, renderSafeLink(content, repositoryLink));
}
