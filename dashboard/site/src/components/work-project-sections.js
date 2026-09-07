import { h } from '../dom.js';
import { formatUtcDateTime, renderCountBadge } from './ui-primitives.js';
import { renderWorkItemCard } from './work-item-card.js';
import { renderWorkItemRow } from './work-item-row.js';
import { renderWorkItemTimelineLane } from './work-item-timeline-lane.js';

/** @import { SafeLink } from './link-content.js' */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   icon: string,
 *   repository: string,
 *   owner: string,
 *   state: string,
 *   stateLabel: string,
 *   started: string,
 *   startedLabel: string,
 *   stoppedLabel: string,
 *   startTime: number,
 *   stopTime: number,
 *   evidenceLink?: SafeLink | null,
 *   durationLabel: string
 * }} WorkItem
 */

const BOARD_COLUMNS = [
  { title: 'Active', states: ['active'], tone: 'active' },
  { title: 'Waiting', states: ['waiting', 'blocked'], tone: 'waiting' },
  { title: 'Review', states: ['review'], tone: 'review' },
  { title: 'Done', states: ['completed', 'cancelled'], tone: 'completed' }
];

/**
 * @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection
 */

/**
 * @param {WorkItem[]} items
 * @param {WorkSection} section
 * @returns {HTMLElement}
 */
export function renderWorkBoardSection(items, section) {
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    ...BOARD_COLUMNS.map((column) => {
      const columnItems = items.filter((item) => column.states.includes(item.state));
      return h(
        'section',
        { className: `work-board-column work-board-${column.tone}`, 'aria-label': `${column.title} work` },
        h(
          'header',
          null,
          h('h4', null, column.title),
          renderCountBadge(columnItems.length, `${columnItems.length} work items`)
        ),
        h(
          'div',
          { className: 'work-board-cards' },
          ...columnItems.map(renderWorkItemCard)
        )
      );
    })
  );
}

/**
 * @param {WorkItem[]} items
 * @param {WorkSection} section
 * @returns {HTMLElement}
 */
export function renderWorkTaskSection(items, section) {
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-project-section-heading' }, h('h4', null, section.title)),
    h(
      'div',
      { className: 'work-task-list', role: 'list' },
      ...items.map(renderWorkItemRow)
    )
  );
}

/**
 * @param {WorkItem[]} items
 * @param {WorkSection} section
 * @returns {HTMLElement}
 */
export function renderWorkRoadmapSection(items, section) {
  const extents = timelineExtents(items);
  const rangeSize = Math.max(720, items.length * 180 + 180);
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-project-section-heading' }, h('h4', null, section.title)),
    h(
      'div',
      { className: 'work-roadmap-scroll' },
      h(
        'div',
        { className: 'work-roadmap-timeline', style: `min-width: ${rangeSize}px;` },
        h('div', { className: 'work-roadmap-metric-axis' },
          h('span', null, formatUtcDateTime(extents.start)),
          h('span', null, formatUtcDateTime(extents.stop))
        ),
        ...items.map((item) => renderWorkItemTimelineLane(item, extents))
      )
    )
  );
}

/** @param {WorkItem[]} items */
function timelineExtents(items) {
  const starts = items.map((item) => item.startTime).filter(Number.isFinite);
  const stops = items.map((item) => item.stopTime).filter(Number.isFinite);
  const start = Math.min(...starts);
  const stop = Math.max(...stops);
  return {
    start,
    stop,
    duration: Number.isFinite(stop - start) ? Math.max(stop - start, 60_000) : 60_000
  };
}
