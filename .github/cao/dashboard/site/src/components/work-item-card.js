import { h } from '../dom.js';
import { renderLinkedValue } from './link-content.js';
import { nameInitials, renderDlRow, renderIconSpan } from './ui-primitives.js';

/** @import { SafeLink } from './link-content.js' */

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   evidenceLink?: SafeLink | null,
 *   repository: string,
 *   owner: string,
 *   timeLabel: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   durationLabel: string,
 *   state: string,
 *   packageName: string,
 *   workType: string
 * }} item
 * @returns {HTMLElement}
 */
export function renderWorkItemCard(item) {
  return h(
    'article',
    { className: 'work-card', 'data-work-state': item.state },
    h(
      'header',
      null,
      renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
      h('strong', null, renderLinkedValue(item.name, item.evidenceLink ?? null)),
      h('span', {
        className: 'work-owner-avatar',
        'aria-label': `Owner: ${item.owner}`,
        title: `Owner: ${item.owner}`
      }, nameInitials(item.owner))
    ),
    h('p', null, item.repository),
    h('div', { className: 'work-card-labels', 'aria-label': 'Work labels' },
      ...(item.packageName ? [h('span', { className: 'work-card-label work-card-label-package' }, item.packageName)] : []),
      ...(item.workType && item.workType !== 'unknown'
        ? [h('span', { className: 'work-card-label work-card-label-role' }, item.workType)]
        : [])
    ),
    h('dl', null,
      renderDlRow('Owner', item.owner),
      renderDlRow(item.timeLabel, item.startedLabel),
      ...(item.timeLabel === 'Observed' ? [] : [
        renderDlRow('Stopped', item.stoppedLabel),
        renderDlRow('Duration', item.durationLabel)
      ])
    )
  );
}
