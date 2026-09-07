import { h } from '../dom.js';
import { renderLinkedValue } from './link-content.js';
import { renderIconSpan } from './ui-primitives.js';

/** @import { SafeLink } from './link-content.js' */

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   evidenceLink?: SafeLink | null,
 *   repository: string,
 *   owner: string,
 *   started: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   state: string,
 *   stateLabel: string
 * }} item
 * @returns {HTMLElement}
 */
export function renderWorkItemRow(item) {
  return h(
    'article',
    { className: 'work-task-row', role: 'listitem' },
    renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
    h('div', { className: 'work-task-main' },
      h('strong', null, renderLinkedValue(item.name, item.evidenceLink ?? null)),
      h('span', null, item.repository)
    ),
    h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel),
    h('span', { className: 'work-task-owner' }, item.owner),
    h('time', { dateTime: item.started }, item.startedLabel),
    h('span', null, item.stoppedLabel)
  );
}
