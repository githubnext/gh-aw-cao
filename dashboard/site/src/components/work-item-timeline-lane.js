import { h } from '../dom.js';
import { renderIconSpan } from './ui-primitives.js';

/**
 * @param {{
 *   name: string,
 *   icon: string,
 *   owner: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   state: string,
 *   startTime: number,
 *   stopTime: number
 * }} item
 * @param {{ start: number, duration: number }} extents
 * @returns {HTMLElement}
 */
export function renderWorkItemTimelineLane(item, extents) {
  const startOffset = extents.duration > 0 ? ((item.startTime - extents.start) / extents.duration) * 100 : 0;
  const itemDuration = Math.max(item.stopTime - item.startTime, 60_000);
  const width = extents.duration > 0 ? Math.max(8, (itemDuration / extents.duration) * 100) : 100;
  const barStyle = `--work-start: ${Math.max(0, Math.min(100, startOffset)).toFixed(2)}%; --work-width: ${Math.min(100, width).toFixed(2)}%;`;
  return h(
    'article',
    { className: 'work-roadmap-lane' },
    h('div', { className: 'work-roadmap-label' },
      renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
      h('strong', null, item.name)
    ),
    h('div', { className: 'work-roadmap-track' },
      h('span', {
        className: `work-roadmap-bar work-state-${item.state}`,
        style: barStyle
      },
      h('span', { className: 'work-roadmap-avatar' }, renderIconSpan('work-roadmap-avatar-icon', item.icon, { ariaHidden: true })),
      h('span', { className: 'work-roadmap-owner' }, item.owner),
      h('span', { className: 'work-roadmap-dates' }, `${item.startedLabel} → ${item.stoppedLabel}`)
      )
    )
  );
}
