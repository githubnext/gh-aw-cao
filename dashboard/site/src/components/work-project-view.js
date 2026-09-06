import { h } from '../dom.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink, renderLinkedValue } from './link-content.js';
import { rowsFor } from './source-rows.js';
import { formatUtcDateTime, renderEmptyMessage, renderIconSpan, renderSectionHeading } from './ui-primitives.js';

const BOARD_COLUMNS = [
  { title: 'Active', states: ['active'], tone: 'active' },
  { title: 'Waiting', states: ['waiting', 'blocked'], tone: 'waiting' },
  { title: 'Review', states: ['review'], tone: 'review' },
  { title: 'Done', states: ['completed', 'cancelled'], tone: 'completed' }
];

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkProjectView(context) {
  const items = rowsFor(context.sources, 'work-items').map(normalizeWorkItem);
  const headingId = `${context.pageId}-projects-heading`;
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
    h(
      'nav',
      { className: 'work-project-tabs', 'aria-label': 'Work layouts' },
      h('a', { href: '#work-board' }, 'Board'),
      h('a', { href: '#work-tasks' }, 'Tasks'),
      h('a', { href: '#work-roadmap' }, 'Roadmap')
    ),
    items.length === 0
      ? renderEmptyMessage('No work-item telemetry is available in the selected scope.', { role: 'status' })
      : [
          renderBoard(items),
          renderTasks(items),
          renderRoadmap(items)
        ]
  );
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function renderBoard(items) {
  return h(
    'section',
    { className: 'work-board', id: 'work-board', 'aria-label': 'Board' },
    ...BOARD_COLUMNS.map((column) => {
      const columnItems = items.filter((item) => column.states.includes(item.state));
      return h(
        'section',
        { className: `work-board-column work-board-${column.tone}`, 'aria-label': `${column.title} work` },
        h(
          'header',
          null,
          h('h4', null, column.title),
          h('span', { className: 'count-badge', 'aria-label': `${columnItems.length} work items` }, String(columnItems.length))
        ),
        h(
          'div',
          { className: 'work-board-cards' },
          ...columnItems.map(renderWorkCard)
        )
      );
    })
  );
}

/** @param {ReturnType<typeof normalizeWorkItem>} item */
function renderWorkCard(item) {
  const body = [
    h(
      'header',
      null,
      renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
      h('strong', null, renderLinkedValue(item.name, item.evidenceLink))
    ),
    h('p', null, item.repository),
    h('dl', null,
      renderFact('Owner', item.owner),
      renderFact('Started', item.startedLabel),
      renderFact('Stopped', item.stoppedLabel),
      renderFact('Duration', item.durationLabel)
    )
  ];
  return h('article', { className: 'work-card', 'data-work-state': item.state }, ...body);
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function renderTasks(items) {
  return h(
    'section',
    { className: 'work-tasks', id: 'work-tasks', 'aria-label': 'Tasks' },
    h('div', { className: 'work-project-section-heading' }, h('h4', null, 'Tasks')),
    h(
      'div',
      { className: 'work-task-list', role: 'list' },
      ...items.map((item) => h(
        'article',
        { className: 'work-task-row', role: 'listitem' },
        renderIconSpan('work-avatar', item.icon, { ariaHidden: true }),
        h('div', { className: 'work-task-main' },
          h('strong', null, renderLinkedValue(item.name, item.evidenceLink)),
          h('span', null, item.repository)
        ),
        h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel),
        h('span', { className: 'work-task-owner' }, item.owner),
        h('time', { dateTime: item.started }, item.startedLabel),
        h('span', null, item.stoppedLabel)
      ))
    )
  );
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function renderRoadmap(items) {
  const extents = timelineExtents(items);
  return h(
    'section',
    { className: 'work-roadmap', id: 'work-roadmap', 'aria-label': 'Roadmap' },
    h('div', { className: 'work-project-section-heading' }, h('h4', null, 'Roadmap')),
    h(
      'div',
      { className: 'work-roadmap-lanes' },
      ...items.map((item) => {
        const startOffset = extents.duration > 0 ? ((item.startTime - extents.start) / extents.duration) * 100 : 0;
        const itemDuration = Math.max(item.stopTime - item.startTime, 60_000);
        const width = extents.duration > 0 ? Math.max(8, (itemDuration / extents.duration) * 100) : 100;
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
              style: `--work-start: ${Math.max(0, Math.min(100, startOffset)).toFixed(2)}%; --work-width: ${Math.min(100, width).toFixed(2)}%;`
            })
          ),
          h('div', { className: 'work-roadmap-time' }, `${item.startedLabel} → ${item.stoppedLabel}`)
        );
      })
    )
  );
}

/**
 * @param {string} label
 * @param {string} value
 */
function renderFact(label, value) {
  return h('div', null, h('dt', null, label), h('dd', null, value));
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

/** @param {string} value */
function titleCase(value) {
  return value.replace(/(^|-)([a-z])/g, (_, prefix, character) => `${prefix ? ' ' : ''}${character.toUpperCase()}`);
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
