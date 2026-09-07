/**
 * Declarative work view section renderers.
 */

import { h } from '../dom.js';
import { formatUtcDateTime, renderCountBadge } from './ui-primitives.js';
import { renderWorkItemCard } from './work-item-card.js';
import { renderWorkItemRow } from './work-item-row.js';
import { renderWorkItemTimelineLane } from './work-item-timeline-lane.js';

/** @typedef {'renderBoard'|'renderTasks'|'renderRoadmap'} WorkViewRendererName */
/** @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection */
/** @typedef {Array<{
 *   state: string,
 *   startTime: number,
 *   stopTime: number
 * } & Record<string, unknown>>} WorkItems
 */

const WORK_VIEW_SECTION_RENDERERS = {
  board: 'renderBoard',
  tasks: 'renderTasks',
  roadmap: 'renderRoadmap'
};

/**
 * @param {string} section
 * @returns {section is keyof typeof WORK_VIEW_SECTION_RENDERERS}
 */
export function isWorkViewSection(section) {
  return Object.hasOwn(WORK_VIEW_SECTION_RENDERERS, section);
}

/**
 * @param {string} section
 * @param {Record<WorkViewRendererName, unknown>} renderers
 * @returns {WorkViewRendererName | null}
 */
export function workViewSectionRenderer(section, renderers) {
  if (!isWorkViewSection(section)) return null;
  const rendererName = /** @type {WorkViewRendererName} */ (WORK_VIEW_SECTION_RENDERERS[section]);
  return rendererName && typeof renderers[rendererName] === 'function'
    ? rendererName
    : null;
}

const BOARD_COLUMNS = [
  { title: 'Active', states: ['active'], tone: 'active' },
  { title: 'Waiting', states: ['waiting', 'blocked'], tone: 'waiting' },
  { title: 'Review', states: ['review'], tone: 'review' },
  { title: 'Done', states: ['completed', 'cancelled'], tone: 'completed' }
];

/** @type {Record<WorkViewRendererName, (items: WorkItems, section: WorkSection) => HTMLElement>} */
const WORK_VIEW_RENDERERS = {
  renderBoard(items, section) {
    return h(
      'section',
      { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
      ...BOARD_COLUMNS.map((column) => {
        const columnItems = items.filter((item) => column.states.includes(String(item.state)));
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
            ...columnItems.map((item) => renderWorkItemCard(/** @type {any} */ (item)))
          )
        );
      })
    );
  },
  renderTasks(items, section) {
    return h(
      'section',
      { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
      h('div', { className: 'work-project-section-heading' }, h('h4', null, section.title)),
      h(
        'div',
        { className: 'work-task-list', role: 'list' },
        ...items.map((item) => renderWorkItemRow(/** @type {any} */ (item)))
      )
    );
  },
  renderRoadmap(items, section) {
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
          ...items.map((item) => renderWorkItemTimelineLane(/** @type {any} */ (item), extents))
        )
      )
    );
  }
};

/**
 * @param {string} section
 * @param {WorkItems} items
 * @param {WorkSection} metadata
 * @returns {HTMLElement | null}
 */
export function renderWorkViewSection(section, items, metadata) {
  const rendererName = workViewSectionRenderer(section, WORK_VIEW_RENDERERS);
  return rendererName ? WORK_VIEW_RENDERERS[rendererName](items, metadata) : null;
}

/** @param {WorkItems} items */
function timelineExtents(items) {
  const starts = items.map((item) => Number(item.startTime)).filter(Number.isFinite);
  const stops = items.map((item) => Number(item.stopTime)).filter(Number.isFinite);
  const start = Math.min(...starts);
  const stop = Math.max(...stops);
  return {
    start,
    stop,
    duration: Number.isFinite(stop - start) ? Math.max(stop - start, 60_000) : 60_000
  };
}
