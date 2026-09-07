import { h } from '../dom.js';
import { renderLinkedValue } from './link-content.js';
import { renderDlRow, renderIconSpan } from './ui-primitives.js';

/** @import { SafeLink } from './link-content.js' */

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   evidenceLink?: SafeLink | null,
 *   repository: string,
 *   owner: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   durationLabel: string,
 *   state: string
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
      h('strong', null, renderLinkedValue(item.name, item.evidenceLink ?? null))
    ),
    h('p', null, item.repository),
    h('dl', null,
      renderDlRow('Owner', item.owner),
      renderDlRow('Started', item.startedLabel),
      renderDlRow('Stopped', item.stoppedLabel),
      renderDlRow('Duration', item.durationLabel)
    )
  );
}
