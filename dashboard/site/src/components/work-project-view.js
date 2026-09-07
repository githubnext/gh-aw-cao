import { h } from '../dom.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { rowsFor } from './source-rows.js';
import { titleCase } from './count-formatters.js';
import { formatUtcDateTime, renderCountBadge, renderEmptyMessage, renderIconSpan } from './ui-primitives.js';
import { renderWorkItemCard } from './work-item-card.js';
import { renderWorkItemRow } from './work-item-row.js';
import { renderWorkItemTimelineLane } from './work-item-timeline-lane.js';
import { workViewComposition } from './work-view-composition.js';
import { workViewSectionRenderer } from './work-view-sections.js';

const BOARD_COLUMNS = [
  { title: 'Todo', states: ['todo'], tone: 'todo' },
  { title: 'In progress', states: ['in-progress'], tone: 'in-progress' },
  { title: 'Needs review', states: ['needs-review'], tone: 'needs-review' },
  { title: 'Done', states: ['done'], tone: 'done' }
];

const WORK_LAYOUT_ROUTES = [
  { key: 'board', title: 'Board', icon: 'project-roadmap', href: '#page-work' },
  { key: 'tasks', title: 'Tasks', icon: 'table', href: '#page-work-tasks' },
  { key: 'roadmap', title: 'Roadmap', icon: 'calendar', href: '#page-work-roadmap' }
];

/** @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection */
/** @typedef {(items: Array<ReturnType<typeof normalizeWorkItem>>, section: WorkSection) => HTMLElement} WorkSectionRenderer */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkProjectView(context) {
  const items = rowsFor(context.sources, 'work-items').map(normalizeWorkItem);
  const sections = workViewComposition(context.elementConfig);
  const activeSection = sections[0]?.key ?? 'board';
  const viewBody = h('div', { className: 'work-project-body' });
  /** @type {Record<'renderBoard'|'renderTasks'|'renderRoadmap', WorkSectionRenderer>} */
  const renderers = { renderBoard, renderTasks, renderRoadmap };
  /** @param {Array<ReturnType<typeof normalizeWorkItem>>} filteredItems */
  const renderItems = (filteredItems) => {
    if (items.length === 0) {
      viewBody.replaceChildren(renderEmptyMessage('No work-item telemetry is available in the selected scope.', { role: 'status' }));
      return;
    }
    if (filteredItems.length === 0) {
      viewBody.replaceChildren(renderEmptyMessage('No work items match the current filters.', { role: 'status' }));
      return;
    }
    viewBody.replaceChildren(...sections
      .map((section) => {
        const rendererName = workViewSectionRenderer(section.key, renderers);
        const renderer = rendererName ? renderers[rendererName] : null;
        return typeof renderer === 'function'
          ? renderer(filteredItems, {
            id: workSectionId(context.pageId, section.key),
            className: section.className,
            landmarkLabel: section.landmarkLabel,
            title: section.title
          })
          : null;
      })
      .filter((element) => element instanceof HTMLElement));
  };
  const filterBar = renderWorkFilterBar(items, renderItems);
  const root = h(
    'section',
    { className: 'work-project-view', 'aria-label': 'Work' },
    h(
      'nav',
      { className: 'work-project-tabs', 'aria-label': 'Work views' },
      ...WORK_LAYOUT_ROUTES.map((route) => h(
        'a',
        {
          href: route.href,
          'aria-current': route.key === activeSection ? 'page' : undefined
        },
        renderIconSpan('work-project-tab-icon', route.icon, { ariaHidden: true }),
        route.title
      ))
    ),
    filterBar,
    viewBody
  );
  renderItems(items);
  return root;
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {(items: Array<ReturnType<typeof normalizeWorkItem>>) => void} onChange
 */
function renderWorkFilterBar(items, onChange) {
  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search',
    placeholder: 'Filter work items',
    'aria-label': 'Filter work items',
    spellcheck: 'false'
  }));
  const state = renderFacetSelect('State', items.map((item) => item.stateLabel));
  const repository = renderFacetSelect('Repository', items.map((item) => item.repository));
  const owner = renderFacetSelect('Workflow owner', items.map((item) => item.owner));
  const packageName = renderFacetSelect('Package', items.map((item) => item.packageName).filter(Boolean));
  const resultCount = h('output', { className: 'work-filter-count', 'aria-live': 'polite' });
  const clear = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-filter-clear',
    'aria-label': 'Clear work filters',
    title: 'Clear filters'
  }, renderIconSpan('work-filter-clear-icon', 'x', { ariaHidden: true })));
  const controls = [search, state, repository, owner, packageName];
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    const filteredItems = items.filter((item) => {
      const searchable = [item.name, item.repository, item.owner, item.packageName, item.stateLabel].join(' ').toLowerCase();
      return (!query || searchable.includes(query))
        && (!state.value || item.stateLabel === state.value)
        && (!repository.value || item.repository === repository.value)
        && (!owner.value || item.owner === owner.value)
        && (!packageName.value || item.packageName === packageName.value);
    });
    const activeFilterCount = controls.filter((control) => control.value !== '').length;
    resultCount.textContent = `${filteredItems.length} of ${items.length}`;
    resultCount.setAttribute('aria-label', `${filteredItems.length} of ${items.length} work items shown`);
    clear.disabled = activeFilterCount === 0;
    onChange(filteredItems);
  };
  search.addEventListener('input', apply);
  for (const select of [state, repository, owner, packageName]) select.addEventListener('change', apply);
  clear.addEventListener('click', () => {
    for (const control of controls) control.value = '';
    apply();
    search.focus();
  });
  queueMicrotask(apply);

  return h('form', {
    className: 'work-filter-bar',
    role: 'search',
    'aria-label': 'Work filters',
    onsubmit: /** @param {SubmitEvent} event */ (event) => event.preventDefault()
  },
  h('label', { className: 'work-filter-search' },
    renderIconSpan('work-filter-search-icon', 'search', { ariaHidden: true }),
    search
  ),
  h('div', { className: 'work-filter-facets' }, state, repository, owner, packageName),
  resultCount,
  clear);
}

/** @param {string} label @param {string[]} values */
function renderFacetSelect(label, values) {
  return /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': `Filter by ${label.toLowerCase()}` },
    h('option', { value: '' }, label),
    ...[...new Set(values)].sort((left, right) => left.localeCompare(right)).map((value) => h('option', { value }, value))
  ));
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderBoard(items, section) {
  const orchestratedPackages = orchestratedPackageNames(items);
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
          ...groupWorkItems(columnItems, orchestratedPackages).map((group) => group.grouped
            ? h('section', { className: 'work-card-stack', 'aria-label': `${group.label} work` },
              h('header', null,
                h('strong', null, group.label),
                renderCountBadge(group.items.length, `${group.items.length} work items`)
              ),
              renderWorkItemCard(group.items[0]),
              ...(group.items.length > 1
                ? [h('details', { className: 'work-card-workers' },
                  h('summary', null,
                    renderIconSpan('work-card-workers-chevron', 'chevron-right', { ariaHidden: true }),
                    h('span', null, `${group.items.length - 1} worker${group.items.length === 2 ? '' : 's'}`),
                    h('small', null, 'Show cards')
                  ),
                  h('div', { className: 'work-card-worker-list' }, ...group.items.slice(1).map(renderWorkItemCard))
                )]
                : [])
            )
            : renderWorkItemCard(group.items[0]))
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
  const list = h('div', { className: 'work-task-list', role: 'list' });
  const sort = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Sort tasks by' },
    h('option', { value: 'started' }, 'Start date'),
    h('option', { value: 'name' }, 'Title'),
    h('option', { value: 'state' }, 'Status'),
    h('option', { value: 'owner' }, 'Owned by'),
    h('option', { value: 'package' }, 'Package')));
  const direction = h('button', { type: 'button', className: 'work-task-sort-direction', 'aria-label': 'Sort descending', title: 'Sort descending' }, renderIconSpan('work-task-sort-icon', 'arrow-down', { ariaHidden: true }));
  let descending = true;
  const renderRows = () => {
    const sorted = items.toSorted((left, right) => compareWorkItems(left, right, sort.value) * (descending ? -1 : 1));
    list.replaceChildren(...sorted.map(renderWorkItemRow));
  };
  sort.addEventListener('change', renderRows);
  direction.addEventListener('click', () => {
    descending = !descending;
    direction.setAttribute('aria-label', descending ? 'Sort descending' : 'Sort ascending');
    direction.setAttribute('title', descending ? 'Sort descending' : 'Sort ascending');
    direction.replaceChildren(renderIconSpan('work-task-sort-icon', descending ? 'arrow-down' : 'arrow-up', { ariaHidden: true }));
    renderRows();
  });
  /** @param {string} field @param {string} label */
  const sortableHeader = (field, label) => h('button', {
    type: 'button',
    className: 'work-task-column-sort',
    'aria-label': `Sort by ${label.toLowerCase()}`,
    onclick: () => {
      if (sort.value === field) descending = !descending;
      else {
        sort.value = field;
        descending = field === 'started';
      }
      direction.setAttribute('aria-label', descending ? 'Sort descending' : 'Sort ascending');
      direction.setAttribute('title', descending ? 'Sort descending' : 'Sort ascending');
      direction.replaceChildren(renderIconSpan('work-task-sort-icon', descending ? 'arrow-down' : 'arrow-up', { ariaHidden: true }));
      renderRows();
    }
  }, label, renderIconSpan('work-task-header-sort-icon', 'triangle-down', { ariaHidden: true }));
  renderRows();
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-task-viewbar' },
      h('div', { className: 'work-task-view-name' }, renderIconSpan('work-task-view-icon', 'table', { ariaHidden: true }), h('strong', null, 'Operations tasks'), h('span', null, `${items.length} items`)),
      h('label', { className: 'work-task-sort' }, h('span', null, 'Sort by'), sort),
      direction
    ),
    h('div', { className: 'work-task-scroll' },
      h('div', { className: 'work-task-table-header', role: 'row' },
        h('span', { 'aria-hidden': 'true' }),
        sortableHeader('name', 'Title'),
        sortableHeader('state', 'Status'),
        h('span', null, 'Type'),
        sortableHeader('package', 'Labels'),
        sortableHeader('started', 'Start'),
        h('span', null, 'End'),
        sortableHeader('owner', 'Owned by')),
      list
    )
  );
}

/** @param {ReturnType<typeof normalizeWorkItem>} left @param {ReturnType<typeof normalizeWorkItem>} right @param {string} field */
function compareWorkItems(left, right, field) {
  if (field === 'started') return left.startTime - right.startTime;
  if (field === 'state') return left.state.localeCompare(right.state);
  if (field === 'owner') return left.repository.localeCompare(right.repository);
  if (field === 'package') return left.packageName.localeCompare(right.packageName);
  return left.name.localeCompare(right.name);
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderRoadmap(items, section) {
  const body = h('div', { className: 'work-roadmap-body' });
  const zoomLevels = ['day', 'week', 'month', 'quarter', 'year'];
  let range = 'year';
  const zoomLabel = h('span', { className: 'work-roadmap-zoom-label' }, 'Year');
  const zoomMenu = h('div', { className: 'work-roadmap-zoom-menu', role: 'menu', 'aria-label': 'Zoom level' });
  const zoom = h('details', { className: 'work-roadmap-zoom' },
    h('summary', { 'aria-label': 'Roadmap zoom level' },
      renderIconSpan('work-roadmap-zoom-icon', 'zoom-in', { ariaHidden: true }),
      zoomLabel
    ),
    h('div', { className: 'work-roadmap-zoom-popover' },
      h('strong', null, 'Zoom level'),
      zoomMenu
    )
  );
  const today = h('button', { type: 'button', className: 'work-roadmap-today-button' }, 'Today');
  const renderTimeline = () => {
    const extents = calendarExtents(items, range);
    const ticks = timelineDateTicks(extents, range);
    const periods = timelinePeriods(extents, range);
    const contextBands = timelineContextBands(extents, range);
    const rangeSize = roadmapRangeSize(range);
    const now = Date.now();
    const todayOffset = ((now - extents.start) / extents.duration) * 100;
    const todayLabel = `Today · ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(now))}`;
    const scroll = h(
      'div',
      { className: 'work-roadmap-scroll' },
      h(
        'div',
        {
          className: 'work-roadmap-timeline',
          style: `--roadmap-grid-width: ${rangeSize}px; --roadmap-divisions: ${Math.max(1, periods.length)};`
        },
        h('div', { className: 'work-roadmap-calendar' },
          h('div', { className: 'work-roadmap-corner' }, 'Title'),
          h('div', { className: 'work-roadmap-calendar-grid', 'aria-label': 'Roadmap calendar' },
            h('div', { className: 'work-roadmap-quarters' },
              ...contextBands.map((band) => h('span', {
                style: `--period-start: ${band.start.toFixed(2)}%; --period-width: ${band.width.toFixed(2)}%;`
              }, band.label))
            ),
            h('div', { className: 'work-roadmap-periods' },
              ...periods.map((period) => h('span', {
                style: `--period-start: ${period.start.toFixed(2)}%; --period-width: ${period.width.toFixed(2)}%;`
              }, period.label))
            ),
            h('div', { className: 'work-roadmap-ticks' },
              ...ticks.map((tick) => h('time', {
                dateTime: new Date(tick.time).toISOString(),
                style: `--tick-position: ${tick.position.toFixed(2)}%;`
              }, tick.label))
            )
          )
        ),
        ...items.toSorted((left, right) => left.startTime - right.startTime).map((item, index) => renderWorkItemTimelineLane(item, extents, index, Math.max(1, ticks.length))),
        todayOffset >= 0 && todayOffset <= 100
          ? h('span', {
            className: 'work-roadmap-today',
            style: `--today-position: ${(rangeSize * todayOffset / 100).toFixed(2)}px;`,
            title: todayLabel,
            'aria-label': todayLabel,
            'data-label': todayLabel
          })
          : null
      )
    );
    body.replaceChildren(scroll);
    const latestWorkTime = Math.max(...items.flatMap((item) => [item.startTime, item.stopTime]).filter(Number.isFinite));
    const focusTime = now >= extents.start && now <= extents.stop ? now : latestWorkTime;
    const focusOffset = Math.max(0, Math.min(1, (focusTime - extents.start) / extents.duration));
    queueMicrotask(() => {
      const labelWidth = scroll.querySelector('.work-roadmap-corner')?.getBoundingClientRect().width ?? 320;
      scroll.scrollLeft = Math.max(0, focusOffset * rangeSize - Math.max(0, scroll.clientWidth - labelWidth) / 2);
    });
    today.onclick = () => {
      const labelWidth = scroll.querySelector('.work-roadmap-corner')?.getBoundingClientRect().width ?? 320;
      const left = (Math.max(0, Math.min(100, todayOffset)) / 100) * rangeSize;
      scroll.scrollTo({ left: Math.max(0, left - Math.max(0, scroll.clientWidth - labelWidth) / 2), behavior: 'smooth' });
    };
  };
  zoomMenu.append(...zoomLevels.map((level) => h('button', {
    type: 'button',
    role: 'menuitemradio',
    'aria-checked': String(level === range),
    'data-roadmap-zoom': level,
    onclick: (/** @type {MouseEvent} */ event) => {
      range = level;
      zoomLabel.textContent = titleCase(level);
      for (const button of zoomMenu.querySelectorAll('[role="menuitemradio"]')) button.setAttribute('aria-checked', String(button === event.currentTarget));
      zoom.removeAttribute('open');
      renderTimeline();
    }
  }, renderIconSpan('work-roadmap-zoom-check', 'check', { ariaHidden: true }), titleCase(level))));
  renderTimeline();
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-roadmap-toolbar' },
      h('div', null, renderIconSpan('work-roadmap-toolbar-icon', 'project-roadmap', { ariaHidden: true }), h('strong', null, section.title), h('span', null, `${items.length} items`)),
      zoom,
      today
    ),
    body
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
  const lifecycleState = text(row['lifecycle-state']);
  const state = normalizeState(lifecycleState);
  const inferred = text(row['reason-evidence-class']) === 'inferred';
  const pointInTime = inferred || (!stopped && state !== 'in-progress');
  const stopTime = pointInTime ? startTime : validTime(stopped) ?? Math.max(startTime, Date.now());
  const owner = text(row.owner) || text(row.organization) || 'Unassigned';
  const workType = text(row['work-type']) || text(row['workflow-role']) || 'unknown';
  const packageName = text(row.package)
    || text(row['package-name'])
    || (workType === 'orchestrator' || workType === 'worker' ? owner : '');
  return {
    id: text(row['work-item-id']) || text(row.workflow) || text(row.objective),
    name: text(row.name) || text(row['workflow-name']) || text(row.objective) || 'Unknown workflow',
    icon: text(row['workflow-icon']) || text(row['package-icon']) || 'workflow',
    repository: text(row.scope) || [text(row.organization), text(row.repository)].filter(Boolean).join('/') || 'Repository unavailable',
    owner,
    packageName,
    workType,
    safeOutputKind: text(row['safe-output-kind']) || 'workflow-output',
    actor: text(row['next-actor']) || actorForLifecycle(lifecycleState),
    state,
    stateLabel: titleCase(state),
    started,
    timeLabel: inferred ? 'Observed' : 'Started',
    startedLabel: started ? formatUtcDateTime(started) : inferred ? 'Observation unavailable' : 'Start unavailable',
    stoppedLabel: stopped ? formatUtcDateTime(stopped) : state === 'in-progress' ? 'Still running' : 'End unavailable',
    startTime,
    stopTime,
    pointInTime,
    evidenceLink: findLink(row, 'evidence-link') || findLink(row, 'run-link'),
    durationLabel: Number.isFinite(stopTime - startTime) ? formatClockDuration(Math.max(0, (stopTime - startTime) / 1000)) : ''
  };
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items @param {string} range */
function calendarExtents(items, range) {
  const starts = items.map((item) => item.startTime).filter(Number.isFinite);
  const stops = items.map((item) => item.stopTime).filter(Number.isFinite);
  const anchor = Math.max(...stops, ...starts);
  const date = new Date(Number.isFinite(anchor) ? anchor : Date.now());
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const quarterStart = Math.floor(date.getUTCMonth() / 3) * 3;
  const dayStart = Date.UTC(year, month, day);
  const weekday = (date.getUTCDay() + 6) % 7;
  const start = {
    day: dayStart,
    week: dayStart - weekday * 86_400_000,
    month: Date.UTC(year, month, 1),
    quarter: Date.UTC(year, quarterStart, 1),
    year: Date.UTC(year, 0, 1)
  }[range] ?? Date.UTC(year, 0, 1);
  const stop = {
    day: start + 86_400_000,
    week: start + 7 * 86_400_000,
    month: Date.UTC(year, month + 1, 1),
    quarter: Date.UTC(year, quarterStart + 3, 1),
    year: Date.UTC(year + 1, 0, 1)
  }[range] ?? Date.UTC(year + 1, 0, 1);
  return {
    start,
    stop,
    duration: stop - start
  };
}

/** @param {{ start: number, stop: number, duration: number }} extents @param {string} range */
function timelineDateTicks(extents, range) {
  const ticks = [];
  if (range === 'day' || range === 'week') {
    const step = range === 'day' ? 2 * 3_600_000 : 12 * 3_600_000;
    for (let time = extents.start; time < extents.stop; time += step) ticks.push({
      time,
      position: ((time - extents.start) / extents.duration) * 100,
      label: new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(time))
    });
    return ticks;
  }
  const startDate = new Date(extents.start);
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  while (cursor < extents.stop) {
    const date = new Date(cursor);
    const days = range === 'month' ? Array.from({ length: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() }, (_, index) => index + 1) : [1, 15];
    for (const day of days) {
      const time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day);
      if (time >= extents.start && time < extents.stop) ticks.push({ time, position: ((time - extents.start) / extents.duration) * 100, label: String(day) });
    }
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return ticks;
}

/** @param {{ start: number, stop: number, duration: number }} extents @param {string} range */
function timelinePeriods(extents, range) {
  if (range === 'day') return timelineFixedPeriods(extents, 6 * 3_600_000, (time) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(time)));
  if (range === 'week') return timelineFixedPeriods(extents, 86_400_000, (time) => new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(time)));
  if (range === 'month') return timelineFixedPeriods(extents, 7 * 86_400_000, (time) => `Week of ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(time))}`);
  const startDate = new Date(extents.start);
  const periods = [];
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  while (cursor < extents.stop && periods.length < 18) {
    const date = new Date(cursor);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const visibleStart = Math.max(cursor, extents.start);
    const visibleStop = Math.min(next, extents.stop);
    if (visibleStop > visibleStart) {
      periods.push({
        label: new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date),
        start: ((visibleStart - extents.start) / extents.duration) * 100,
        width: ((visibleStop - visibleStart) / extents.duration) * 100
      });
    }
    cursor = next;
  }
  return periods;
}

/** @param {{ start: number, stop: number, duration: number }} extents @param {string} range */
function timelineContextBands(extents, range) {
  if (range === 'day') return timelineFixedPeriods(extents, extents.duration, (time) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(time)));
  if (range === 'week' || range === 'month') return timelineMonthBands(extents);
  const startDate = new Date(extents.start);
  const quarters = [];
  let cursor = Date.UTC(startDate.getUTCFullYear(), Math.floor(startDate.getUTCMonth() / 3) * 3, 1);
  while (cursor < extents.stop) {
    const date = new Date(cursor);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 1);
    const visibleStart = Math.max(cursor, extents.start);
    const visibleStop = Math.min(next, extents.stop);
    if (visibleStop > visibleStart) quarters.push({
      label: `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`,
      start: ((visibleStart - extents.start) / extents.duration) * 100,
      width: ((visibleStop - visibleStart) / extents.duration) * 100
    });
    cursor = next;
  }
  return quarters;
}

/** @param {{ start: number, stop: number, duration: number }} extents @param {number} step @param {(time: number) => string} labelFor */
function timelineFixedPeriods(extents, step, labelFor) {
  const periods = [];
  for (let time = extents.start; time < extents.stop; time += step) periods.push({
    label: labelFor(time),
    start: ((time - extents.start) / extents.duration) * 100,
    width: (Math.min(step, extents.stop - time) / extents.duration) * 100
  });
  return periods;
}

/** @param {{ start: number, stop: number, duration: number }} extents */
function timelineMonthBands(extents) {
  const date = new Date(extents.start);
  let cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const periods = [];
  while (cursor < extents.stop) {
    const nextDate = new Date(cursor);
    const next = Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 1);
    const visibleStart = Math.max(cursor, extents.start);
    const visibleStop = Math.min(next, extents.stop);
    periods.push({
      label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(nextDate),
      start: ((visibleStart - extents.start) / extents.duration) * 100,
      width: ((visibleStop - visibleStart) / extents.duration) * 100
    });
    cursor = next;
  }
  return periods;
}

/** @param {string} range */
function roadmapRangeSize(range) {
  return { day: 1440, week: 1260, month: 1240, quarter: 960, year: 1440 }[range] ?? 1440;
}

/** @param {string} state */
function normalizeState(state) {
  const normalized = state.toLowerCase();
  if (['active', 'in-progress', 'in_progress', 'running'].includes(normalized)) return 'in-progress';
  if (['blocked', 'review', 'needs-review', 'needs_review', 'action-required'].includes(normalized)) return 'needs-review';
  if (['completed', 'cancelled', 'success', 'failure', 'done'].includes(normalized)) return 'done';
  return 'todo';
}

/** @param {string} state */
function actorForLifecycle(state) {
  const normalized = state.toLowerCase();
  if (['active', 'in-progress', 'in_progress', 'running'].includes(normalized)) return 'agent';
  if (['review', 'needs-review', 'needs_review'].includes(normalized)) return 'reviewer';
  if (['blocked', 'action-required', 'failure'].includes(normalized)) return 'maintainer';
  if (['completed', 'cancelled', 'success', 'done'].includes(normalized)) return 'reviewer';
  return 'scheduler';
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function orchestratedPackageNames(items) {
  const roles = new Map();
  for (const item of items) {
    if (!item.packageName || item.packageName === 'standalone') continue;
    const packageRoles = roles.get(item.packageName) ?? new Set();
    packageRoles.add(item.workType);
    roles.set(item.packageName, packageRoles);
  }
  return new Set([...roles].filter(([, packageRoles]) => packageRoles.has('orchestrator') && packageRoles.has('worker')).map(([name]) => name));
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {Set<string>} orchestratedPackages
 */
function groupWorkItems(items, orchestratedPackages) {
  /** @type {Map<string, { key: string, label: string, grouped: boolean, items: Array<ReturnType<typeof normalizeWorkItem>> }>} */
  const groups = new Map();
  for (const item of items) {
    const grouped = orchestratedPackages.has(item.packageName);
    const key = grouped ? `package:${item.packageName}` : `item:${item.id}`;
    const group = groups.get(key) ?? { key, label: item.packageName || item.name, grouped, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    items: group.items.toSorted((left, right) => roleOrder(left.workType) - roleOrder(right.workType))
  }));
}

/** @param {string} role */
function roleOrder(role) {
  if (role === 'orchestrator') return 0;
  if (role === 'worker') return 1;
  return 2;
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ start: number, duration: number }} extents
 * @param {number} divisions
 */
/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} value */
function validTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
