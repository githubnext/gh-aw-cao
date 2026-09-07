import { h } from '../dom.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { rowsFor } from './source-rows.js';
import { titleCase } from './count-formatters.js';
import { formatUtcDateTime, renderCountBadge, renderEmptyMessage, renderSectionHeading } from './ui-primitives.js';
import { renderWorkItemCard } from './work-item-card.js';
import { renderWorkItemRow } from './work-item-row.js';
import { renderWorkItemTimelineLane } from './work-item-timeline-lane.js';
import { workViewComposition } from './work-view-composition.js';
import { workViewSectionRenderer } from './work-view-sections.js';

const BOARD_COLUMNS = [
  { title: 'Active', states: ['active'], tone: 'active' },
  { title: 'Waiting', states: ['waiting', 'blocked'], tone: 'waiting' },
  { title: 'Review', states: ['review'], tone: 'review' },
  { title: 'Done', states: ['completed', 'cancelled'], tone: 'completed' }
];

/** @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection */
/** @typedef {(items: Array<ReturnType<typeof normalizeWorkItem>>, section: WorkSection) => HTMLElement} WorkSectionRenderer */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkProjectView(context) {
  const items = rowsFor(context.sources, 'work-items').map(normalizeWorkItem);
  const headingId = `${context.pageId}-projects-heading`;
  const sections = workViewComposition(context.elementConfig);
  /** @type {Record<'renderBoard'|'renderTasks'|'renderRoadmap', WorkSectionRenderer>} */
  const renderers = { renderBoard, renderTasks, renderRoadmap };
  return h(
    'section',
    { className: 'work-project-view', 'aria-labelledby': headingId },
    renderSectionHeading({
      kicker: 'Dashboard Next',
      id: headingId,
      title: context.title,
      description: context.description,
      headingTag: context.headingTag
    }),
    sections.length > 1
      ? h(
        'nav',
        { className: 'work-project-tabs', 'aria-label': 'Work layouts' },
        ...sections.map((section) => h('a', { href: `#${workSectionId(context.pageId, section.key)}` }, section.title))
      )
      : null,
    items.length === 0
      ? renderEmptyMessage('No work-item telemetry is available in the selected scope.', { role: 'status' })
      : sections
        .map((section) => {
          const rendererName = workViewSectionRenderer(section.key, renderers);
          const renderer = rendererName ? renderers[rendererName] : null;
          return typeof renderer === 'function'
            ? renderer(items, {
              id: workSectionId(context.pageId, section.key),
              className: section.className,
              landmarkLabel: section.landmarkLabel,
              title: section.title
            })
            : null;
        })
        .filter(Boolean)
  );
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderBoard(items, section) {
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
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderTasks(items, section) {
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
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderRoadmap(items, section) {
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

/** @param {string} pageId @param {'board'|'tasks'|'roadmap'} key */
function workSectionId(pageId, key) {
  return `${pageId}-${key}`;
}

/** @param {Record<string, unknown>} row */
function normalizeWorkItem(row) {
  const started = text(row['started-at']) || text(row['observed-at']);
  const stopped = text(row['ended-at']) || text(row['stopped-at']);
  const startTime = validTime(started) ?? Date.now();
  const stopTime = validTime(stopped) ?? Math.max(startTime, Date.now());
  const state = normalizeState(text(row['lifecycle-state']));
  return {
    id: text(row['work-item-id']) || text(row.workflow) || text(row.objective),
    name: text(row['workflow-name']) || text(row.name) || text(row.objective) || 'Unknown workflow',
    icon: text(row['workflow-icon']) || text(row['package-icon']) || 'workflow',
    repository: text(row.scope) || [text(row.organization), text(row.repository)].filter(Boolean).join('/') || 'Repository unavailable',
    owner: text(row.owner) || text(row.organization) || 'Unassigned',
    state,
    stateLabel: titleCase(state),
    started,
    startedLabel: started ? formatUtcDateTime(started) : 'Start unavailable',
    stoppedLabel: stopped ? formatUtcDateTime(stopped) : state === 'completed' ? 'Stop unavailable' : 'Still running',
    startTime,
    stopTime,
    evidenceLink: findLink(row, 'evidence-link') || findLink(row, 'run-link'),
    durationLabel: Number.isFinite(stopTime - startTime) ? formatClockDuration(Math.max(0, (stopTime - startTime) / 1000)) : ''
  };
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
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

/** @param {string} state */
function normalizeState(state) {
  const normalized = state.toLowerCase();
  if (['active', 'waiting', 'blocked', 'review', 'completed', 'cancelled'].includes(normalized)) return normalized;
  if (['success', 'failure'].includes(normalized)) return 'completed';
  return 'active';
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} value */
function validTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
