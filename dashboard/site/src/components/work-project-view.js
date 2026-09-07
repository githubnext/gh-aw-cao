import { h } from '../dom.js';
import { formatClockDuration } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { rowsFor } from './source-rows.js';
import { titleCase } from './count-formatters.js';
import { formatUtcDateTime, renderCloseButton, renderCountBadge, renderEmptyMessage, renderIconSpan } from './ui-primitives.js';
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
  { key: 'tasks', title: 'Table', icon: 'table', href: '#page-work-tasks' },
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
  let reapplyFilters = () => renderItems(items);
  /** @type {Record<'renderBoard'|'renderTasks'|'renderRoadmap', WorkSectionRenderer>} */
  const renderers = {
    renderBoard: (filteredItems, section) => renderBoard(filteredItems, section, reapplyFilters),
    renderTasks: (filteredItems, section) => renderTasks(filteredItems, section, reapplyFilters),
    renderRoadmap: (filteredItems, section) => renderRoadmap(filteredItems, section, reapplyFilters)
  };
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
  reapplyFilters = filterBar.apply;
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
    filterBar.element,
    viewBody
  );
  renderItems(items);
  return root;
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {(items: Array<ReturnType<typeof normalizeWorkItem>>) => void} onChange
 * @returns {{ element: HTMLElement, apply: () => void }}
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
  const mobileFilterToggle = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'work-filter-mobile-toggle',
    'aria-expanded': 'false'
  }, renderIconSpan('work-filter-mobile-icon', 'filter', { ariaHidden: true }), 'Filters'));
  const closeMobileFilters = renderCloseButton({
    className: 'work-mobile-sheet-close',
    label: 'Close work filters',
    onClick: () => closeMobileSheet()
  });
  const facets = h('div', { className: 'work-filter-facets' },
    h('div', { className: 'work-filter-sheet-panel' },
      h('header', { className: 'work-mobile-sheet-header' }, h('strong', null, 'Filter work'), closeMobileFilters),
      state, repository, owner, packageName
    )
  );
  const closeMobileSheet = () => {
    facets.classList.remove('is-open');
    mobileFilterToggle.setAttribute('aria-expanded', 'false');
    mobileFilterToggle.focus();
  };
  mobileFilterToggle.addEventListener('click', () => {
    const open = !facets.classList.contains('is-open');
    facets.classList.toggle('is-open', open);
    mobileFilterToggle.setAttribute('aria-expanded', String(open));
    if (open) state.focus();
  });
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
  return { element, apply };
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
 * @param {() => void} onUpdate
 */
function renderBoard(items, section, onUpdate) {
  const orchestratedPackages = orchestratedPackageNames(items);
  const choices = workItemChoices(items);
  const populatedAttentionColumn = ['needs-review', 'in-progress', 'todo', 'done']
    .find((tone) => items.some((item) => item.state === tone));
  let activeTone = populatedAttentionColumn ?? 'todo';
  const tabs = h('div', { className: 'work-board-group-tabs', role: 'tablist', 'aria-label': 'Board status' });
  const columns = BOARD_COLUMNS.map((column) => {
    const columnItems = items.filter((item) => column.states.includes(item.state));
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
        ...groupWorkItems(columnItems, orchestratedPackages).map((group) => group.grouped
          ? h('section', { className: 'work-card-stack', 'aria-label': `${group.label} work` },
            h('header', null,
              h('strong', null, group.label),
              renderCountBadge(group.items.length, `${group.items.length} work items`)
            ),
            decorateMobileWorkItem(renderWorkItemCard(group.items[0]), group.items[0], choices, onUpdate),
            ...(group.items.length > 1
              ? [h('details', { className: 'work-card-workers' },
                h('summary', null,
                  renderIconSpan('work-card-workers-chevron', 'chevron-right', { ariaHidden: true }),
                  h('span', null, `${group.items.length - 1} worker${group.items.length === 2 ? '' : 's'}`),
                  h('small', null, 'Show cards')
                ),
                h('div', { className: 'work-card-worker-list' }, ...group.items.slice(1).map((item) => decorateMobileWorkItem(renderWorkItemCard(item), item, choices, onUpdate)))
              )]
              : [])
          )
          : decorateMobileWorkItem(renderWorkItemCard(group.items[0]), group.items[0], choices, onUpdate))
      )
    );
  });
  tabs.append(...BOARD_COLUMNS.map((column) => {
    const count = items.filter((item) => column.states.includes(item.state)).length;
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
 * @param {() => void} onUpdate
 */
function renderTasks(items, section, onUpdate) {
  const list = h('div', { className: 'work-task-list work-mobile-hide-repository work-mobile-hide-dates', role: 'list' });
  const choices = workItemChoices(items);
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
    list.replaceChildren(...sorted.map((item) => decorateMobileWorkItem(renderWorkItemRow(item), item, choices, onUpdate, 'table')));
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
          onClick: () => closeSettings()
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
    'aria-expanded': 'false',
    onclick: () => {
      settingsSheet.classList.add('is-open');
      settingsToggle.setAttribute('aria-expanded', 'true');
      settingsSheet.querySelector('input')?.focus();
    }
  }, renderIconSpan('work-task-settings-icon', 'filter', { ariaHidden: true }), 'Fields & sort'));
  const closeSettings = () => {
    settingsSheet.classList.remove('is-open');
    settingsToggle.setAttribute('aria-expanded', 'false');
    settingsToggle.focus();
  };
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
  if (field === 'owner') return left.owner.localeCompare(right.owner);
  if (field === 'package') return left.packageName.localeCompare(right.packageName);
  return left.name.localeCompare(right.name);
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ id: string, className: string, landmarkLabel: string, title: string }} section
 * @param {() => void} onUpdate
 */
function renderRoadmap(items, section, onUpdate) {
  const body = h('div', { className: 'work-roadmap-body' });
  const choices = workItemChoices(items);
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
  const mobilePeriod = h('span', { className: 'work-roadmap-mobile-period', 'aria-live': 'polite' });
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
        ...renderRoadmapItems(items, extents, Math.max(1, ticks.length), choices, onUpdate),
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
    repositoryLink: findLink(row, 'repository-link'),
    durationLabel: Number.isFinite(stopTime - startTime) ? formatClockDuration(Math.max(0, (stopTime - startTime) / 1000)) : '',
    reason: text(row.reason),
    nextAction: text(row['next-action']),
    waitingOn: text(row['waiting-on']),
    consequenceTier: text(row['consequence-tier']),
    verificationState: text(row['verification-state']),
    outcomeState: text(row['outcome-state'])
  };
}

/** @param {Array<ReturnType<typeof normalizeWorkItem>>} items */
function workItemChoices(items) {
  return {
    owners: [...new Set(items.map((item) => item.owner).filter(Boolean))].sort(),
    labels: [...new Set(items.map((item) => item.packageName).filter(Boolean))].sort()
  };
}

/**
 * @param {HTMLElement} element
 * @param {ReturnType<typeof normalizeWorkItem>} item
 * @param {{ owners: string[], labels: string[] }} choices
 * @param {() => void} onUpdate
 * @param {'board'|'table'|'roadmap'} [variant]
 */
function decorateMobileWorkItem(element, item, choices, onUpdate, variant = 'board') {
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
  const move = /** @type {HTMLSelectElement} */ (h('select', {
    'aria-label': `Move ${item.name} to`,
    onchange: (/** @type {Event} */ event) => {
      const state = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
      if (!state) return;
      item.state = state;
      item.stateLabel = titleCase(state);
      onUpdate();
    }
  },
  h('option', { value: '' }, 'Move to…'),
  ...BOARD_COLUMNS.map((column) => h('option', { value: column.tone }, column.title))));
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', {
    className: 'work-mobile-detail',
    'aria-label': `${item.name} details`
  }));
  const closeDetail = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  };
  /** @param {string} label @param {string} value @param {string[]} values @param {'owner'|'packageName'} property */
  const updateSelect = (label, value, values, property) => h('label', { className: 'work-mobile-detail-control' },
    h('span', null, label),
    h('select', {
      'aria-label': `${label} for ${item.name}`,
      onchange: (/** @type {Event} */ event) => {
        item[property] = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
        onUpdate();
      }
    }, ...values.map((option) => h('option', { value: option, selected: option === value }, option)))
  );
  dialog.append(
    h('header', null,
      h('div', null, renderIconSpan('work-avatar', item.icon, { ariaHidden: true }), h('h2', null, item.name)),
      renderCloseButton({ className: 'work-mobile-detail-close', label: `Close ${item.name} details`, onClick: closeDetail })
    ),
    h('main', null,
      h('div', { className: 'work-mobile-detail-status' }, h('span', { className: `work-state work-state-${item.state}` }, item.stateLabel), item.repository),
      h('dl', null,
        mobileDetailRow('Owner', item.owner),
        mobileDetailRow('Label', item.packageName || 'None'),
        mobileDetailRow('Type', item.workType === 'unknown' ? 'Unknown' : item.workType),
        mobileDetailRow(item.timeLabel, item.startedLabel),
        ...(item.timeLabel === 'Observed' ? [] : [mobileDetailRow('End', item.stoppedLabel), mobileDetailRow('Duration', item.durationLabel)]),
        ...(item.reason ? [mobileDetailRow('Why it needs attention', item.reason)] : []),
        ...(item.waitingOn ? [mobileDetailRow('Waiting on', item.waitingOn)] : []),
        ...(item.nextAction ? [mobileDetailRow('Next action', item.nextAction)] : []),
        ...(item.consequenceTier ? [mobileDetailRow('Priority', item.consequenceTier)] : []),
        ...(item.verificationState ? [mobileDetailRow('Verification', item.verificationState)] : [])
      ),
      h('section', { className: 'work-mobile-quick-update', 'aria-label': `Quick update ${item.name}` },
        h('h3', null, 'Quick update'),
        updateSelect('Owner', item.owner, choices.owners, 'owner'),
        updateSelect('Label', item.packageName, choices.labels, 'packageName')
      )
    )
  );
  const detailsButton = h('button', {
    type: 'button',
    className: 'work-mobile-details-button',
    'aria-label': `Open ${item.name} details`,
    onclick: () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }, 'Details', renderIconSpan('work-mobile-details-icon', 'chevron-right', { ariaHidden: true }));
  element.append(h('footer', { className: 'work-mobile-item-actions' }, move, detailsButton), dialog);
  return element;
}

/** @param {string} label @param {string} value */
function mobileDetailRow(label, value) {
  return h('div', null, h('dt', null, label), h('dd', null, value || 'Unavailable'));
}

/**
 * @param {Array<ReturnType<typeof normalizeWorkItem>>} items
 * @param {{ start: number, duration: number }} extents
 * @param {number} divisions
 * @param {{ owners: string[], labels: string[] }} choices
 * @param {() => void} onUpdate
 */
function renderRoadmapItems(items, extents, divisions, choices, onUpdate) {
  const rendered = [];
  let period = '';
  const sorted = items.toSorted((left, right) => left.startTime - right.startTime);
  for (const [index, item] of sorted.entries()) {
    const itemPeriod = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(item.startTime));
    if (itemPeriod !== period) {
      period = itemPeriod;
      rendered.push(h('h4', { className: 'work-roadmap-period-heading' }, period));
    }
    rendered.push(decorateMobileWorkItem(renderWorkItemTimelineLane(item, extents, index, divisions), item, choices, onUpdate, 'roadmap'));
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
