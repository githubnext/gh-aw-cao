import { h } from '../dom.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { rowsFor } from './source-rows.js';
import { formatCountOf, textValue, titleCase } from './count-formatters.js';
import { createExpandableToggle, createModalDialog, formatUtcDateTime, renderCloseButton, renderCountBadge, renderDlRow, renderEmptyMessage, renderFilterSelect, renderIconSpan, renderLiveRegion, renderSearchInput } from './ui-primitives.js';
import { renderWorkItemCard } from './work-item-card.js';
import { renderWorkItemRow } from './work-item-row.js';
import { renderWorkItemTimelineLane } from './work-item-timeline-lane.js';
import { workViewComposition } from './work-view-composition.js';
import { renderWorkViewNavigation } from './work-view-navigation.js';
import { workRoutePageConfigs } from './work-view-route-config.js';
import { workViewSectionRenderer } from './work-view-sections.js';

const BOARD_COLUMNS = [
  { title: 'Todo', tone: 'todo', source: 'work-board-todo' },
  { title: 'In progress', tone: 'in-progress', source: 'work-board-in-progress' },
  { title: 'Needs review', tone: 'needs-review', source: 'work-board-needs-review' },
  { title: 'Done', tone: 'done', source: 'work-board-done' }
];

/** @typedef {{ id: string, className: string, landmarkLabel: string, title: string }} WorkSection */
/** @typedef {(items: Array<ReturnType<typeof normalizeWorkItem>>, section: WorkSection) => HTMLElement} WorkSectionRenderer */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkProjectView(context) {
  const sections = workViewComposition(context.elementConfig);
  const activeSection = sections[0].key;
  const boardItems = Object.fromEntries(BOARD_COLUMNS.map((column) => [
    column.tone,
    rowsFor(context.sources, column.source).map(normalizeWorkItem)
  ]));
  const sourceRows = activeSection === 'board'
    ? BOARD_COLUMNS.flatMap((column) => rowsFor(context.sources, column.source))
    : rowsFor(context.sources, activeSection === 'roadmap' ? 'work-roadmap-items' : 'work-project-items');
  const items = sourceRows.map(normalizeWorkItem);
  const facetRow = sourceRows[0] ?? {};
  const totalItems = Number(facetRow['work-total-count']) || items.length;
  const viewBody = h('div', { className: 'work-project-body' });
  /** @type {Record<'renderBoard'|'renderTasks'|'renderRoadmap', WorkSectionRenderer>} */
  const renderers = {
    renderBoard: (_filteredItems, section) => renderBoard(boardItems, section),
    renderTasks: (filteredItems, section) => renderTasks(filteredItems, section, context),
    renderRoadmap: (filteredItems, section) => renderRoadmap(filteredItems, section)
  };
  /** @param {Array<ReturnType<typeof normalizeWorkItem>>} filteredItems */
  const renderItems = (filteredItems) => {
    if (items.length === 0 && !hasWorkQueryContext(context.queryContext)) {
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
  const filterBar = renderWorkFilterBar({
    pageId: context.pageId,
    queryContext: context.queryContext,
    visible: items.length,
    total: totalItems,
    facets: {
      states: stringValues(facetRow['work-state-options']),
      repositories: stringValues(facetRow['work-repository-options']),
      owners: stringValues(facetRow['work-owner-options']),
      campaigns: stringValues(facetRow['work-campaign-options'])
    }
  });
  const root = h(
    'section',
    { className: 'work-project-view', 'aria-label': 'Work' },
    renderWorkViewNavigation(workRoutePageConfigs(), activeSection),
    filterBar,
    viewBody
  );
  renderItems(items);
  return root;
}

/**
 * @param {{ pageId: string, queryContext?: import('./ui-elements.js').ElementRenderContext['queryContext'], visible: number, total: number, facets: { states: string[], repositories: string[], owners: string[], campaigns: string[] } }} options
 * @returns {HTMLElement}
 */
function renderWorkFilterBar(options) {
  const search = renderSearchInput('Filter work items');
  const selectedFilters = options.queryContext?.filters ?? {};
  search.value = options.queryContext?.search?.query ?? '';
  const state = renderFacetSelect('State', withSelected(options.facets.states, selectedFilters['work-state-label']?.[0]));
  const repository = renderFacetSelect('Repository', withSelected(options.facets.repositories, selectedFilters['work-repository']?.[0]));
  const owner = renderFacetSelect('Workflow owner', withSelected(options.facets.owners, selectedFilters['work-owner']?.[0]));
  const campaignName = renderFacetSelect('Campaign', withSelected(options.facets.campaigns, selectedFilters['work-campaign']?.[0]));
  state.value = selectedFilters['work-state-label']?.[0] ?? '';
  repository.value = selectedFilters['work-repository']?.[0] ?? '';
  owner.value = selectedFilters['work-owner']?.[0] ?? '';
  campaignName.value = selectedFilters['work-campaign']?.[0] ?? '';
  const resultCount = /** @type {HTMLOutputElement} */ (renderLiveRegion('output', 'work-filter-count'));
  const clear = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-filter-clear',
    'aria-label': 'Clear work filters',
    title: 'Clear filters'
  }, renderIconSpan('work-filter-clear-icon', 'x', { ariaHidden: true })));
  const mobileFilterToggle = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-filter-mobile-toggle'
  }, renderIconSpan('work-filter-mobile-icon', 'filter', { ariaHidden: true }), 'Filters'));
  const closeMobileFilters = renderCloseButton({
    className: 'work-mobile-sheet-close',
    label: 'Close work filters',
    onClick: () => mobileFilters.close()
  });
  const facets = h('div', { className: 'work-filter-facets' },
    h('div', { className: 'work-filter-sheet-panel' },
      h('header', { className: 'work-mobile-sheet-header' }, h('strong', null, 'Filter work'), closeMobileFilters),
      state, repository, owner, campaignName
    )
  );
  const mobileFilters = createExpandableToggle(mobileFilterToggle, facets, {
    expandedClass: 'is-open',
    onExpand: (open) => { if (open) state.focus(); }
  });
  mobileFilterToggle.addEventListener('click', () => {
    mobileFilters.setExpanded(!facets.classList.contains('is-open'));
  });
  const controls = [search, state, repository, owner, campaignName];
  const apply = () => {
    const activeFilterCount = controls.filter((control) => control.value !== '').length;
    clear.disabled = activeFilterCount === 0;
    const filters = { ...(options.queryContext?.filters ?? {}) };
    for (const [field, value] of [
      ['work-state-label', state.value],
      ['work-repository', repository.value],
      ['work-owner', owner.value],
      ['work-campaign', campaignName.value]
    ]) {
      if (value) filters[field] = [value];
      else delete filters[field];
    }
    const query = search.value.trim();
    const queryContext = {
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(query ? { search: { fields: ['work-search'], query } } : {}),
      ...(options.queryContext?.timeWindow ? { timeWindow: options.queryContext.timeWindow } : {})
    };
    element.dispatchEvent(new CustomEvent('dashboard-query-context-change', {
      bubbles: true,
      detail: { pageId: options.pageId, queryContext }
    }));
  };
  search.addEventListener('input', apply);
  for (const select of [state, repository, owner, campaignName]) select.addEventListener('change', apply);
  clear.addEventListener('click', () => {
    for (const control of controls) control.value = '';
    apply();
    search.focus();
  });
  const element = h('form', {
    className: 'work-filter-bar',
    role: 'search',
    'aria-label': 'Work filters',
    onsubmit: /** @param {SubmitEvent} event */ (event) => event.preventDefault()
  },
  h('label', { className: 'work-filter-search' },
    renderIconSpan('work-filter-search-icon', 'search', { ariaHidden: true }),
    search
  ),
  mobileFilterToggle,
  facets,
  resultCount,
  clear);
  resultCount.textContent = formatCountOf(options.visible, options.total);
  resultCount.setAttribute('aria-label', `${options.visible} of ${options.total} work items shown`);
  clear.disabled = controls.every((control) => control.value === '');
  return element;
}

/** @param {unknown} value */
function stringValues(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(String) : [];
}

/** @param {string[]} values @param {string | undefined} selected */
function withSelected(values, selected) {
  return selected && !values.includes(selected) ? [...values, selected] : values;
}

/** @param {import('./ui-elements.js').ElementRenderContext['queryContext']} queryContext */
function hasWorkQueryContext(queryContext) {
  return Boolean(queryContext?.search?.query || Object.keys(queryContext?.filters ?? {}).some((field) => field.startsWith('work-')));
}

/** @param {string} label @param {string[]} values */
function renderFacetSelect(label, values) {
  return renderFilterSelect(`Filter by ${label.toLowerCase()}`, label, values,
    (left, right) => left.localeCompare(right));
}

/**
 * @param {Record<string, Array<ReturnType<typeof normalizeWorkItem>>>} itemsByTone
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderBoard(itemsByTone, section) {
  const populatedAttentionColumn = ['needs-review', 'in-progress', 'todo', 'done']
    .find((tone) => (itemsByTone[tone]?.length ?? 0) > 0);
  let activeTone = populatedAttentionColumn ?? 'todo';
  const tabs = h('div', { className: 'work-board-group-tabs', role: 'tablist', 'aria-label': 'Board status' });
  const columns = BOARD_COLUMNS.map((column) => {
    const columnItems = itemsByTone[column.tone] ?? [];
    return h(
      'section',
      {
        className: `work-board-column work-board-${column.tone}`,
        'aria-label': `${column.title} work`,
        dataset: { mobileActive: String(column.tone === activeTone) }
      },
      h(
        'header',
        null,
        h('h4', null, column.title),
        renderCountBadge(columnItems.length, `${columnItems.length} work items`)
      ),
      h(
        'div',
        { className: 'work-board-cards' },
        ...groupWorkItems(columnItems).map((group) => group.grouped
          ? h('section', { className: 'work-card-stack', 'aria-label': `${group.label} work` },
            h('header', null,
              h('strong', null, group.label),
              renderCountBadge(group.items.length, `${group.items.length} work items`)
            ),
            decorateMobileWorkItem(renderWorkItemCard(group.items[0]), group.items[0]),
            ...(group.items.length > 1
              ? [h('details', { className: 'work-card-workers' },
                h('summary', null,
                  renderIconSpan('work-card-workers-chevron', 'chevron-right', { ariaHidden: true }),
                  h('span', null, `${group.items.length - 1} worker${group.items.length === 2 ? '' : 's'}`),
                  h('small', null, 'Show cards')
                ),
                h('div', { className: 'work-card-worker-list' }, ...group.items.slice(1).map((item) => decorateMobileWorkItem(renderWorkItemCard(item), item)))
              )]
              : [])
          )
          : decorateMobileWorkItem(renderWorkItemCard(group.items[0]), group.items[0]))
      )
    );
  });
  tabs.append(...BOARD_COLUMNS.map((column) => {
    const count = itemsByTone[column.tone]?.length ?? 0;
    const button = h('button', {
      type: 'button',
      className: 'work-board-group-tab',
      role: 'tab',
      'aria-selected': String(column.tone === activeTone),
      onclick: () => {
        activeTone = column.tone;
        for (const tab of tabs.querySelectorAll('[role="tab"]')) {
          tab.setAttribute('aria-selected', String(tab === button));
        }
        for (const boardColumn of columns) {
          boardColumn.setAttribute('data-mobile-active', String(boardColumn.classList.contains(`work-board-${activeTone}`)));
        }
      }
    }, column.title, renderCountBadge(count, `${count} work items`));
    return button;
  }));
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    tabs,
    ...columns
  );
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
function renderTasks(items, section, context) {
  const list = h('div', { className: 'work-task-list work-mobile-hide-repository work-mobile-hide-dates', role: 'list' });
  const sort = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Sort tasks by' },
    h('option', { value: 'started' }, 'Start date'),
    h('option', { value: 'name' }, 'Title'),
    h('option', { value: 'state' }, 'Status'),
    h('option', { value: 'owner' }, 'Owned by'),
    h('option', { value: 'campaign' }, 'Campaign')));
  const direction = h('button', { type: 'button', className: 'work-task-sort-direction', 'aria-label': 'Sort descending', title: 'Sort descending' }, renderIconSpan('work-task-sort-icon', 'arrow-down', { ariaHidden: true }));
  const requestedOrder = context.queryContext?.orderBy?.[0];
  const sortField = Object.entries(TASK_SORT_FIELDS).find(([, field]) => field === requestedOrder?.field)?.[0] ?? 'started';
  sort.value = sortField;
  let descending = requestedOrder?.direction ? requestedOrder.direction === 'desc' : true;
  const renderRows = () => {
    list.replaceChildren(...items.map((item) => decorateMobileWorkItem(renderWorkItemRow(item), item, 'table')));
  };
  const requestSort = () => list.dispatchEvent(new CustomEvent('dashboard-query-context-change', {
    bubbles: true,
    detail: {
      pageId: context.pageId,
      queryContext: {
        ...(context.queryContext?.filters ? { filters: context.queryContext.filters } : {}),
        ...(context.queryContext?.search ? { search: context.queryContext.search } : {}),
        orderBy: [{ field: TASK_SORT_FIELDS[sort.value] ?? 'started-at', direction: descending ? 'desc' : 'asc' }],
        ...(context.queryContext?.timeWindow ? { timeWindow: context.queryContext.timeWindow } : {})
      }
    }
  }));
  sort.addEventListener('change', () => {
    descending = sort.value === 'started';
    requestSort();
  });
  direction.addEventListener('click', () => {
    descending = !descending;
    direction.setAttribute('aria-label', descending ? 'Sort descending' : 'Sort ascending');
    direction.setAttribute('title', descending ? 'Sort descending' : 'Sort ascending');
    direction.replaceChildren(renderIconSpan('work-task-sort-icon', descending ? 'arrow-down' : 'arrow-up', { ariaHidden: true }));
    requestSort();
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
      requestSort();
    }
  }, label, renderIconSpan('work-task-header-sort-icon', 'triangle-down', { ariaHidden: true }));
  const sortControls = h('div', { className: 'work-task-sort-controls' },
    h('label', { className: 'work-task-sort' }, h('span', null, 'Sort by'), sort),
    direction
  );
  const fieldOptions = [
    { value: 'repository', label: 'Repository', checked: false },
    { value: 'status', label: 'Status', checked: true },
    { value: 'owner', label: 'Owner', checked: true },
    { value: 'label', label: 'Label', checked: true },
    { value: 'dates', label: 'Dates', checked: false }
  ];
  const settingsSheet = h('div', { className: 'work-task-settings-sheet' },
    h('div', { className: 'work-task-settings-panel' },
      h('header', { className: 'work-mobile-sheet-header' },
        h('strong', null, 'Table settings'),
        renderCloseButton({
          className: 'work-mobile-sheet-close',
          label: 'Close Table settings',
          onClick: () => settingsPanel.close()
        })
      ),
      h('fieldset', { className: 'work-mobile-field-settings' },
        h('legend', null, 'Fields shown'),
        ...fieldOptions.map(({ value, label, checked }) => h('label', null,
          h('input', {
            type: 'checkbox',
            name: 'mobile-work-field',
            value,
            checked,
            onchange: (/** @type {Event} */ event) => {
              const input = /** @type {HTMLInputElement} */ (event.currentTarget);
              list.classList.toggle(`work-mobile-hide-${value}`, !input.checked);
            }
          }),
          label
        ))
      ),
      sortControls
    )
  );
  const settingsToggle = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-task-settings-toggle',
    onclick: () => settingsPanel.setExpanded(true)
  }, renderIconSpan('work-task-settings-icon', 'filter', { ariaHidden: true }), 'Fields & sort'));
  const settingsPanel = createExpandableToggle(settingsToggle, settingsSheet, {
    expandedClass: 'is-open',
    onExpand: (open) => { if (open) settingsSheet.querySelector('input')?.focus(); }
  });
  renderRows();
  return h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-task-viewbar' },
      h('div', { className: 'work-task-view-name' }, renderIconSpan('work-task-view-icon', 'table', { ariaHidden: true }), h('strong', null, 'Operations tasks'), h('span', null, `${items.length} items`)),
      h('div', { className: 'work-task-settings' }, settingsToggle, settingsSheet)
    ),
    h('div', { className: 'work-task-scroll' },
      h('div', { className: 'work-task-table-header', role: 'row' },
        h('span', { 'aria-hidden': 'true' }),
        sortableHeader('name', 'Title'),
        sortableHeader('state', 'Status'),
        h('span', null, 'Type'),
        sortableHeader('campaign', 'Labels'),
        sortableHeader('started', 'Start'),
        h('span', null, 'End'),
        sortableHeader('owner', 'Owned by')),
      list
    )
  );
}

/** @type {Record<string, string>} */
const TASK_SORT_FIELDS = {
  started: 'started-at',
  name: 'work-name',
  state: 'work-state',
  owner: 'work-owner',
  campaign: 'work-campaign'
};

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 */
function renderRoadmap(items, section) {
  const body = h('div', { className: 'work-roadmap-body' });
  const zoomLevels = ['day', 'week', 'month', 'quarter', 'year'];
  let range = 'year';
  let periodOffset = 0;
  /** @type {HTMLElement | null} */
  let root = null;
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
  const mobilePeriod = renderLiveRegion('span', 'work-roadmap-mobile-period');
  const previousPeriod = h('button', {
    type: 'button',
    'aria-label': 'Previous month',
    onclick: () => {
      range = 'month';
      periodOffset -= 1;
      renderTimeline();
    }
  }, renderIconSpan('work-roadmap-period-icon', 'chevron-left', { ariaHidden: true }));
  const nextPeriod = h('button', {
    type: 'button',
    'aria-label': 'Next month',
    onclick: () => {
      range = 'month';
      periodOffset += 1;
      renderTimeline();
    }
  }, renderIconSpan('work-roadmap-period-icon', 'chevron-right', { ariaHidden: true }));
  const mobilePeriodControls = h('div', { className: 'work-roadmap-mobile-controls', 'aria-label': 'Visual timeline period' },
    previousPeriod, mobilePeriod, nextPeriod
  );
  const visualToggle = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-roadmap-visual-toggle',
    'aria-label': 'Show visual timeline',
    onclick: () => {
      const visual = !root?.classList.contains('work-roadmap-visual');
      root?.classList.toggle('work-roadmap-visual', visual);
      visualToggle.setAttribute('aria-label', visual ? 'Show list timeline' : 'Show visual timeline');
      visualToggle.replaceChildren(renderIconSpan('work-roadmap-visual-icon', visual ? 'list-unordered' : 'project-roadmap', { ariaHidden: true }), visual ? 'List' : 'Visual');
      if (visual) {
        range = 'month';
        periodOffset = 0;
        renderTimeline();
      }
    }
  }, renderIconSpan('work-roadmap-visual-icon', 'project-roadmap', { ariaHidden: true }), 'Visual'));
  const renderTimeline = () => {
    const extents = calendarExtents(items, range, periodOffset);
    const ticks = timelineDateTicks(extents, range);
    const periods = timelinePeriods(extents, range);
    const contextBands = timelineContextBands(extents, range);
    const rangeSize = roadmapRangeSize(range);
    const now = Date.now();
    const todayOffset = ((now - extents.start) / extents.duration) * 100;
    const todayLabel = `Today · ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(now))}`;
    mobilePeriod.textContent = timelinePeriodLabel(extents, range);
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
        ...renderRoadmapItems(items, extents, Math.max(1, ticks.length)),
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
      if (periodOffset !== 0) {
        periodOffset = 0;
        renderTimeline();
        return;
      }
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
      periodOffset = 0;
      zoomLabel.textContent = titleCase(level);
      for (const button of zoomMenu.querySelectorAll('[role="menuitemradio"]')) button.setAttribute('aria-checked', String(button === event.currentTarget));
      zoom.removeAttribute('open');
      renderTimeline();
    }
  }, renderIconSpan('work-roadmap-zoom-check', 'check', { ariaHidden: true }), titleCase(level))));
  root = h(
    'section',
    { className: section.className, id: section.id, 'aria-label': section.landmarkLabel },
    h('div', { className: 'work-roadmap-toolbar' },
      h('div', null, renderIconSpan('work-roadmap-toolbar-icon', 'project-roadmap', { ariaHidden: true }), h('strong', null, section.title), h('span', null, `${items.length} items`)),
      visualToggle,
      mobilePeriodControls,
      zoom,
      today
    ),
    body
  );
  renderTimeline();
  return root;
}

/** @param {string} pageId @param {'board'|'tasks'|'roadmap'} key */
function workSectionId(pageId, key) {
  return `${pageId}-${key}`;
}

/** @param {Record<string, unknown>} row */
function normalizeWorkItem(row) {
  const started = textValue(row['work-started']);
  const stopped = textValue(row['work-stopped']);
  const startTime = validTime(started) ?? Date.now();
  const state = textValue(row['work-state']);
  const inferred = textValue(row['reason-evidence-class']) === 'inferred';
  const pointInTime = inferred || (!stopped && state !== 'in-progress');
  const stopTime = pointInTime ? startTime : validTime(stopped) ?? Math.max(startTime, Date.now());
  const owner = textValue(row['work-owner']);
  const workType = textValue(row['work-type-normalized']);
  const campaignName = textValue(row['work-campaign']);
  return {
    id: textValue(row['work-id']),
    name: textValue(row['work-name']),
    icon: textValue(row['work-icon']),
    repository: textValue(row['work-repository']),
    owner,
    campaignName,
    workType,
    groupId: textValue(row['work-group-id']),
    groupLabel: textValue(row['work-group-label']),
    grouped: row['work-grouped'] === true,
    safeOutputKind: textValue(row['work-safe-output-kind']),
    actor: textValue(row['work-actor']),
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
    repositoryLink: findLink(row, 'repository-link'),
    durationLabel: Number.isFinite(stopTime - startTime) ? formatClockDuration(Math.max(0, (stopTime - startTime) / 1000)) : '',
    reason: textValue(row.reason),
    nextAction: textValue(row['next-action']),
    waitingOn: textValue(row['waiting-on']),
    consequenceTier: textValue(row['consequence-tier']),
    verificationState: textValue(row['verification-state']),
    outcomeState: textValue(row['outcome-state'])
  };
}

/**
 * @param {HTMLElement} element
 * @param {ReturnType<typeof normalizeWorkItem>} item
 * @param {'board'|'table'|'roadmap'} [variant]
 */
function decorateMobileWorkItem(element, item, variant = 'board') {
  element.setAttribute('data-work-id', item.id);
  if (variant === 'table') {
    element.append(h('span', { className: 'work-mobile-owner' }, item.owner));
  }
  if (variant === 'roadmap') {
    element.querySelector('.work-roadmap-label')?.append(h('div', { className: 'work-roadmap-mobile-meta' },
      h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel),
      h('span', null, item.timeLabel === 'Observed' ? item.startedLabel : `${item.startedLabel} – ${item.stoppedLabel}`),
      ...(item.waitingOn ? [h('span', null, `Waiting on ${item.waitingOn}`)] : [])
    ));
  }
  const { dialog, open: openDetail, close: closeDetail } = createModalDialog({
    className: 'work-mobile-detail',
    ariaLabel: `${item.name} details`
  });
  dialog.append(
    h('header', null,
      h('div', null, renderIconSpan('work-avatar', item.icon, { ariaHidden: true }), h('h2', null, item.name)),
      renderCloseButton({ className: 'work-mobile-detail-close', label: `Close ${item.name} details`, onClick: closeDetail })
    ),
    h('main', null,
      h('div', { className: 'work-mobile-detail-status' }, h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel), item.repository),
      h('dl', null,
        mobileDetailRow('Owner', item.owner),
        mobileDetailRow('Label', item.campaignName || 'None'),
        mobileDetailRow('Type', item.workType === 'unknown' ? 'Unknown' : item.workType),
        mobileDetailRow(item.timeLabel, item.startedLabel),
        ...(item.timeLabel === 'Observed' ? [] : [mobileDetailRow('End', item.stoppedLabel), mobileDetailRow('Duration', item.durationLabel)]),
        ...(item.reason ? [mobileDetailRow('Why it needs attention', item.reason)] : []),
        ...(item.waitingOn ? [mobileDetailRow('Waiting on', item.waitingOn)] : []),
        ...(item.nextAction ? [mobileDetailRow('Next action', item.nextAction)] : []),
        ...(item.consequenceTier ? [mobileDetailRow('Priority', item.consequenceTier)] : []),
        ...(item.verificationState ? [mobileDetailRow('Verification', item.verificationState)] : [])
      )
    )
  );
  const detailsButton = h('button', {
    type: 'button',
    className: 'work-mobile-details-button',
    'aria-label': `Open ${item.name} details`,
    onclick: () => openDetail()
  }, 'Details', renderIconSpan('work-mobile-details-icon', 'chevron-right', { ariaHidden: true }));
  element.append(h('footer', { className: 'work-mobile-item-actions' }, detailsButton), dialog);
  return element;
}

/** @param {string} label @param {string} value */
function mobileDetailRow(label, value) {
  return renderDlRow(label, value || 'Unavailable');
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ start: number, duration: number }} extents
 * @param {number} divisions
 */
function renderRoadmapItems(items, extents, divisions) {
  const rendered = [];
  let period = '';
  for (const [index, item] of items.entries()) {
    const itemPeriod = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(item.startTime));
    if (itemPeriod !== period) {
      period = itemPeriod;
      rendered.push(h('h4', { className: 'work-roadmap-period-heading' }, period));
    }
    rendered.push(decorateMobileWorkItem(renderWorkItemTimelineLane(item, extents, index, divisions), item, 'roadmap'));
  }
  return rendered;
}

/** @param {{ start: number }} extents @param {string} range */
function timelinePeriodLabel(extents, range) {
  const options = /** @type {Intl.DateTimeFormatOptions} */ (range === 'day'
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : range === 'year'
      ? { year: 'numeric' }
      : { month: 'long', year: 'numeric' });
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(extents.start));
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items @param {string} range @param {number} [offset] */
function calendarExtents(items, range, offset = 0) {
  const starts = items.map((item) => item.startTime).filter(Number.isFinite);
  const stops = items.map((item) => item.stopTime).filter(Number.isFinite);
  const anchor = Math.max(...stops, ...starts);
  const date = new Date(Number.isFinite(anchor) ? anchor : Date.now());
  if (range === 'day') date.setUTCDate(date.getUTCDate() + offset);
  else if (range === 'week') date.setUTCDate(date.getUTCDate() + offset * 7);
  else if (range === 'month') date.setUTCMonth(date.getUTCMonth() + offset);
  else if (range === 'quarter') date.setUTCMonth(date.getUTCMonth() + offset * 3);
  else date.setUTCFullYear(date.getUTCFullYear() + offset);
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

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function groupWorkItems(items) {
  /** @type {Array<{ key: string, label: string, grouped: boolean, items: Array<ReturnType<typeof normalizeWorkItem>> }>} */
  const groups = [];
  for (const item of items) {
    const key = item.groupId || `item:${item.id}`;
    const current = groups.at(-1);
    if (current?.key === key) current.items.push(item);
    else groups.push({ key, label: item.groupLabel || item.name, grouped: item.grouped, items: [item] });
  }
  return groups;
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ start: number, duration: number }} extents
 * @param {number} divisions
 */
/** @param {string} value */
function validTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
