import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatClockDuration } from '../view-formatters.js';
import { buildCatchUpQueue, normalizeNotificationStories } from '../notification-stories.js';
import { findLink } from './link-content.js';
import { smellMark } from './agent-marketplace-view.js';
import { renderLazyInfiniteList } from './lazy-infinite-list.js';
import { formatRoundedPercent } from './count-formatters.js';
import { createExpandableToggle, renderLazyDisclosure, renderLiveRegion, renderSearchInput } from './ui-primitives.js';

const STORAGE_KEY = 'central-agentic-ops.dashboard.notifications';
const CATCH_UP_STORAGE_KEY = 'central-agentic-ops.dashboard.last-catch-up';
const CATCH_UP_QUEUE_STORAGE_KEY = 'central-agentic-ops.dashboard.catch-up-queue';
const DAY_MILLISECONDS = 86_400_000;
const ESTIMATED_NOTIFICATION_HEIGHT = 62;
const MINIMUM_NOTIFICATION_BATCH = 12;
const MAXIMUM_NOTIFICATION_BATCH = 40;
const NOTIFICATION_OVERSCAN = 8;

function notificationBatchSize() {
  const viewportHeight = Number(globalThis.window?.innerHeight) || 768;
  return Math.max(
    MINIMUM_NOTIFICATION_BATCH,
    Math.min(MAXIMUM_NOTIFICATION_BATCH, Math.ceil(viewportHeight / ESTIMATED_NOTIFICATION_HEIGHT) + NOTIFICATION_OVERSCAN)
  );
}

function readState() {
  try {
    const stored = JSON.parse(globalThis.window?.localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      read: new Set(Array.isArray(stored.read) ? stored.read : []),
      saved: new Set(Array.isArray(stored.saved) ? stored.saved : []),
      done: new Set(Array.isArray(stored.done) ? stored.done : [])
    };
  } catch {
    return { read: new Set(), saved: new Set(), done: new Set() };
  }
}

/** @param {{ read: Set<string>, saved: Set<string>, done: Set<string> }} state */
function writeState(state) {
  try {
    globalThis.window?.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      read: [...state.read], saved: [...state.saved], done: [...state.done]
    }));
  } catch {
    // Controls remain usable for this page load when storage is unavailable.
  }
}

/** @returns {{ queue: string[], size: number, seen: Set<string>, done: Set<string>, later: Set<string> }} */
function readCatchUpQueueState() {
  try {
    const stored = JSON.parse(globalThis.window?.localStorage.getItem(CATCH_UP_QUEUE_STORAGE_KEY) ?? '{}');
    return {
      queue: Array.isArray(stored.queue) ? stored.queue : [],
      size: Number(stored.size) || 0,
      seen: new Set(Array.isArray(stored.seen) ? stored.seen : []),
      done: new Set(Array.isArray(stored.done) ? stored.done : []),
      later: new Set(Array.isArray(stored.later) ? stored.later : [])
    };
  } catch {
    return { queue: [], size: 0, seen: new Set(), done: new Set(), later: new Set() };
  }
}

/** @param {{ queue: string[], size: number, seen: Set<string>, done: Set<string>, later: Set<string> }} state */
function writeCatchUpQueueState(state) {
  try {
    globalThis.window?.localStorage.setItem(CATCH_UP_QUEUE_STORAGE_KEY, JSON.stringify({
      queue: state.queue, size: state.size, seen: [...state.seen], done: [...state.done], later: [...state.later]
    }));
  } catch {
    // The Catch Up queue remains usable for this page load when storage is unavailable.
  }
}

/** @param {Iterable<string>} ids */
function markCatchUpStoriesDone(ids) {
  const state = readCatchUpQueueState();
  const done = new Set(ids);
  for (const id of done) {
    state.done.add(id);
    state.later.delete(id);
  }
  state.queue = state.queue.filter((id) => !done.has(id));
  writeCatchUpQueueState(state);
}

/** @param {Record<string, unknown>} row */
function rowId(row) {
  return String(row.id || row['attention-signal-id'] || `${row.scope}:${row.objective}`);
}

/** @param {Record<string, unknown>} row */
function rowStateIds(row) {
  return [rowId(row), ...(Array.isArray(row.contributingRawEventIds) ? row.contributingRawEventIds.map(String) : [])];
}

/** @param {Set<string>} values @param {Record<string, unknown>} row */
function hasRowState(values, row) {
  return rowStateIds(row).some((id) => values.has(id));
}

/** @param {Set<string>} values @param {Record<string, unknown>} row @param {boolean} active */
function setRowState(values, row, active) {
  for (const id of rowStateIds(row)) values.delete(id);
  if (active) values.add(rowId(row));
}

/** @param {Record<string, unknown>} row */
function repository(row) {
  const normalizedRepository = String(row.repository || '');
  if (/^[^/\s]+\/[^/\s]+$/.test(normalizedRepository)) return normalizedRepository;
  const scope = String(row.scope || '');
  if (/^[^/\s]+\/[^/\s]+$/.test(scope)) return scope;
  const link = findLink(row, 'repository-link') ?? findLink(row, 'evidence-link') ?? findLink(row, 'run-link') ?? findLink(row, 'external-link');
  try {
    const url = new URL(link?.href || '');
    const [owner, name] = url.pathname.split('/').filter(Boolean);
    return url.hostname === 'github.com' && owner && name ? `${owner}/${name}` : '';
  } catch {
    return '';
  }
}

/** @param {Record<string, unknown>} row */
function scopeLabel(row) {
  return repository(row) || String(row.scope || 'Unknown scope');
}

/** @param {Record<string, unknown>} row */
function age(row) {
  const seconds = Number(row['age-seconds']);
  if (Number.isFinite(seconds)) return `${formatClockDuration(seconds * 1000)} ago`;
  const timestamp = Number(row.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0
    ? `${formatClockDuration(Math.max(0, Date.now() - timestamp))} ago`
    : 'Recently';
}

/** @param {Record<string, unknown>} row */
function dateGroup(row) {
  const declaredSeconds = Number(row['age-seconds']);
  const timestamp = Number(row.timestamp);
  const seconds = Number.isFinite(declaredSeconds)
    ? declaredSeconds
    : Number.isFinite(timestamp) && timestamp > 0 ? Math.max(0, (Date.now() - timestamp) / 1000) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 86_400) return 'Today';
  if (seconds < 604_800) return 'This week';
  return 'Older';
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} query
 * @param {{ read: Set<string>, saved: Set<string>, done: Set<string> }} state
 * @param {{ done: Set<string>, later: Set<string> }} catchUpState
 */
function matchesQuery(row, query, state, catchUpState) {
  const id = rowId(row);
  const haystack = [
    row.title, row.objective, row.repository, row.scope, row.detail, row.reason,
    row.classification, row.sourceType, row['expected-actor'], row['signal-type']
  ]
    .map((value) => String(value || '').toLowerCase()).join(' ');
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every((token) => {
    if (token === 'is:unread') return !hasRowState(state.read, row);
    if (token === 'is:read') return hasRowState(state.read, row);
    if (token === 'is:saved') return hasRowState(state.saved, row);
    if (token === 'is:done') return hasRowState(state.done, row);
    if (token === 'is:later') return catchUpState.later.has(id) && !catchUpState.done.has(id);
    if (token.startsWith('repo:')) return repository(row).toLowerCase().includes(token.slice(5));
    if (token.startsWith('actor:')) return String(row['expected-actor'] || '').toLowerCase().includes(token.slice(6));
    return haystack.includes(token);
  });
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ outcomes?: Record<string, unknown>[], operationalValues?: Record<string, unknown>[] }} sources
 */
function inboxStories(rows, sources) {
  const now = Date.now();
  const preparedAttention = rows.map((row) => ({
    ...row,
    ...(!row.timestamp && !row['observed-at'] && Number.isFinite(Number(row['age-seconds']))
      ? { timestamp: now - Number(row['age-seconds']) * 1000 }
      : {})
  }));
  const rawRows = new Map(rows.map((row) => [rowId(row), row]));
  const events = [
    ...preparedAttention,
    ...outcomeStoryEvents(sources.outcomes ?? []),
    ...operationalValueStoryEvents((sources.operationalValues ?? []).filter((row) => row['maturity-status'] === 'matured'))
  ];
  return normalizeNotificationStories(events).map((story) => {
    const representative = story.contributingRawEventIds
      .map((id) => rawRows.get(id))
      .find((row) => row !== undefined) ?? {};
    return {
      ...representative,
      ...story,
      'attention-signal-id': story.id,
      objective: story.title,
      reason: story.detail,
      scope: story.repository || representative.scope,
      'signal-type': story.sourceType,
      'age-seconds': undefined
    };
  });
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ runs?: Record<string, unknown>[], workItems?: Record<string, unknown>[], outcomes?: Record<string, unknown>[], operationalValues?: Record<string, unknown>[], evidenceRecords?: Record<string, unknown>[] }} sources
 */
export function renderNotificationsInbox(rows, sources = {}) {
  const stories = inboxStories(rows, sources);
  const state = readState();
  const selected = new Set();
  /** @type {Record<string, unknown>[]} */
  let currentVisible = [];
  let render = () => {};
  let syncSelection = () => {};
  const lazyList = renderLazyInfiniteList({
    items: () => currentVisible,
    batchSize: notificationBatchSize(),
    renderItems: (renderedRows) => {
      if (group.value === 'cause') return renderCauseGroups(renderedRows, state, selected, bulkDone, render);
      const groups = /** @type {Map<string, Record<string, unknown>[]>} */ (new Map());
      for (const row of renderedRows) {
        const label = group.value === 'date' ? dateGroup(row) : group.value === 'repository' ? repository(row) : '';
        const entries = groups.get(label) || [];
        entries.push(row);
        groups.set(label, entries);
      }
      return [...groups].flatMap(([label, entries]) => {
        const entriesList = h('ul', { className: 'notifications-group' },
          ...entries.map((row) => renderNotification(row, state, selected, bulkDone, render)));
        return label ? [h('h3', { className: 'notifications-group-heading' }, label), entriesList] : [entriesList];
      });
    },
    renderEmpty: () => h('div', { className: 'notifications-empty' }, octicon('check-circle'), h('strong', null, 'All caught up')),
    afterRender: () => syncSelection()
  });
  const list = lazyList.element;
  const count = renderLiveRegion('span', 'notifications-result-count');
  const search = renderSearchInput('Filter notifications', 'is:unread');
  const sort = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Sort notifications' },
    h('option', { value: 'newest' }, 'Newest to oldest'),
    h('option', { value: 'oldest' }, 'Oldest to newest'),
    h('option', { value: 'priority' }, 'Highest priority')));
  const group = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Group notifications' },
    h('option', { value: 'cause' }, 'Cause'),
    h('option', { value: 'date' }, 'Date'),
    h('option', { value: 'repository' }, 'Repository'),
    h('option', { value: 'none' }, 'No grouping')));
  const selectAll = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', 'aria-label': 'Select all notifications' }));
  const bulkDone = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'notifications-icon-button', title: 'Mark selected as done',
    'aria-label': 'Mark selected as done', disabled: true
  }, octicon('check')));
  syncSelection = () => {
    for (const checkbox of list.querySelectorAll('.notification-item input[type="checkbox"]')) {
      if (!(checkbox instanceof HTMLInputElement)) continue;
      const notificationId = checkbox.dataset.notificationId;
      checkbox.checked = notificationId !== undefined && selected.has(notificationId);
    }
  };

  /** @param {boolean} [resetWindow] */
  render = (resetWindow = true) => {
    const catchUpState = readCatchUpQueueState();
    let visible = stories.filter((row) => (
      !catchUpState.done.has(rowId(row)) && matchesQuery(row, search.value, state, catchUpState)
    ));
    visible = [...visible].sort((left, right) => {
      if (sort.value === 'priority') return Number(left.priority || 99) - Number(right.priority || 99);
      const leftTimestamp = Number(left.timestamp) || 0;
      const rightTimestamp = Number(right.timestamp) || 0;
      const delta = rightTimestamp - leftTimestamp;
      return sort.value === 'oldest' ? -delta : delta;
    });
    currentVisible = visible;
    count.textContent = `${visible.length} notification${visible.length === 1 ? '' : 's'}`;
    if (resetWindow) {
      selected.clear();
      selectAll.checked = false;
      bulkDone.disabled = true;
    }
    lazyList.render(resetWindow);
  };
  const stateQuery = /\bis:(read|unread|later)\b/g;
  const all = h('button', { type: 'button', onClick: () => { search.value = search.value.replace(stateQuery, '').trim(); render(); } }, 'All');
  const unread = h('button', { type: 'button', onClick: () => { search.value = `${search.value.replace(stateQuery, '').trim()} is:unread`.trim(); render(); } }, 'Unread');
  const later = h('button', { type: 'button', onClick: () => { search.value = `${search.value.replace(stateQuery, '').trim()} is:later`.trim(); render(); } }, 'Later');
  const advancedFilters = h('div', { className: 'notifications-advanced-filters' },
    h('label', { className: 'notifications-search' }, octicon('search'), search),
    h('label', { className: 'notifications-select' }, h('span', null, 'Sort by:'), sort),
    h('label', { className: 'notifications-select' }, h('span', null, 'Group by:'), group));
  const filterToggle = h('button', {
    type: 'button',
    className: 'notifications-filter-toggle',
    onClick: () => setFiltersExpanded(filterToggle.getAttribute('aria-expanded') !== 'true')
  }, octicon('filter'), h('span', null, 'Filters'));
  const setFiltersExpanded = createExpandableToggle(filterToggle, advancedFilters, { expandedClass: 'is-expanded' });
  search.addEventListener('input', () => render());
  sort.addEventListener('change', () => render());
  group.addEventListener('change', () => render());
  selectAll.addEventListener('change', () => {
    selected.clear();
    if (selectAll.checked) {
      for (const row of currentVisible) selected.add(rowId(row));
    }
    for (const checkbox of list.querySelectorAll('.notification-item input[type="checkbox"]')) {
      if (!(checkbox instanceof HTMLInputElement)) continue;
      checkbox.checked = selectAll.checked;
    }
    bulkDone.disabled = selected.size === 0;
  });
  bulkDone.addEventListener('click', () => {
    for (const id of selected) state.done.add(id);
    markCatchUpStoriesDone(selected);
    writeState(state);
    render();
  });
  render();

  const main = h('div', { className: 'notifications-main' },
      h('div', { className: 'notifications-toolbar' },
        h('div', { className: 'notifications-state-tabs' }, all, unread, later),
        filterToggle,
        advancedFilters),
      h('div', { className: 'notifications-selection-bar' },
        h('label', null, selectAll, h('span', null, 'Select all')),
        count,
        bulkDone),
      list);
  const showNotifications = (query = '') => {
    search.value = query;
    render();
    main.scrollIntoView?.();
    search.focus();
  };
  const health = renderOperationalPulse(rows, sources, showNotifications);
  return h('div', { className: `notifications-inbox${stories.length > 0 ? ' has-notifications' : ' is-clear'}` },
    health,
    main);
}

/** @param {Record<string, unknown>} row */
function causeKey(row) {
  const reason = String(row.detail || row.reason || 'No additional detail')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${String(row.sourceType || row['signal-type'] || 'notification').toLowerCase()}:${reason}`;
}

/** @param {Record<string, unknown>} row */
function isHighPriority(row) {
  const consequence = String(row['consequence-tier'] || '').toLowerCase();
  const priority = row.priority === null || row.priority === undefined || row.priority === ''
    ? Number.NaN
    : Number(row.priority);
  return consequence === 'critical' || consequence === 'high' || (Number.isFinite(priority) && priority <= 1);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ read: Set<string>, saved: Set<string>, done: Set<string> }} state
 * @param {Set<string>} selected
 * @param {HTMLButtonElement} bulkDone
 * @param {() => void} render
 */
function renderCauseGroups(rows, state, selected, bulkDone, render) {
  const urgentRows = rows.filter(isHighPriority);
  const clusterableRows = rows.filter((row) => !isHighPriority(row));
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byCause = new Map();
  for (const row of clusterableRows) {
    const key = causeKey(row);
    const entries = byCause.get(key) ?? [];
    entries.push(row);
    byCause.set(key, entries);
  }
  const priorityRows = [...urgentRows, ...clusterableRows.filter((row) => (byCause.get(causeKey(row))?.length ?? 0) === 1)];
  const repeated = [...byCause.values()].filter((entries) => entries.length > 1);
  const content = [];
  if (priorityRows.length > 0) {
    content.push(h('ul', { className: 'notifications-group notifications-priority-group', 'aria-label': 'Priority and unique notifications' },
      ...priorityRows.map((row) => renderNotification(row, state, selected, bulkDone, render))));
  }
  for (const entries of repeated) {
    const first = entries[0];
    const repositories = new Set(entries.map(repository).filter(Boolean));
    const entriesList = h('ul', { className: 'notifications-group' });
    const cluster = renderLazyDisclosure(
      'notifications-cause-cluster',
      [
        h('span', { className: 'notification-kind' }, first?.['signal-type'] === 'agent-smell' ? smellMark() : octicon(String(first?.icon || 'issue'))),
        h('span', { className: 'notifications-cause-copy' },
          h('strong', null, String(first?.detail || first?.reason || 'Repeated notification cause')),
          h('small', null, `${entries.length} occurrences across ${repositories.size} ${repositories.size === 1 ? 'repository' : 'repositories'}`)),
        octicon('chevron-right', 'notifications-cause-chevron')
      ],
      entriesList,
      (container) => container.replaceChildren(...entries.map((row) => renderNotification(row, state, selected, bulkDone, render))),
      { summaryClassName: 'notifications-cause-summary' }
    );
    content.push(cluster);
  }
  return content;
}

const ACTIVE_STATUSES = new Set(['queued', 'in-progress', 'in_progress', 'waiting', 'pending']);

/**
 * @param {Record<string, unknown>[]} attentionRows
 * @param {{ runs?: Record<string, unknown>[], workItems?: Record<string, unknown>[], outcomes?: Record<string, unknown>[], operationalValues?: Record<string, unknown>[], evidenceRecords?: Record<string, unknown>[] }} sources
 * @param {(query?: string) => void} showNotifications
 */
function renderOperationalPulse(attentionRows, sources, showNotifications) {
  const runs = sources.runs ?? [];
  const workItems = sources.workItems ?? [];
  const outcomes = sources.outcomes ?? [];
  const operationalValues = sources.operationalValues ?? [];
  const evidenceRecords = sources.evidenceRecords ?? [];
  const end = latestObservedAt([...runs, ...workItems, ...outcomes, ...operationalValues, ...evidenceRecords]);
  const lastCatchUp = readLastCatchUp();
  const defaultRange = lastCatchUp && lastCatchUp < end ? 'since' : '7d';
  const range = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Catch-up interval' },
    h('option', { value: 'since', disabled: !lastCatchUp, selected: defaultRange === 'since' }, 'Since last catch-up'),
    h('option', { value: '1d' }, 'Last 24 hours'),
    h('option', { value: '7d', selected: defaultRange === '7d' }, 'Last 7 days'),
    h('option', { value: '30d' }, 'Last 30 days')));
  const content = h('div', { className: 'home-catchup-content' });
  const markCaughtUp = h('button', { type: 'button', className: 'home-catchup-done' }, octicon('check'), 'Mark caught up');
  const render = () => {
    const start = range.value === 'since' && lastCatchUp
      ? lastCatchUp
      : end - (Number.parseInt(range.value, 10) || 7) * DAY_MILLISECONDS;
    content.replaceChildren(renderCatchUpContent(
      attentionRows,
      { runs, workItems, outcomes, operationalValues, evidenceRecords },
      start,
      end,
      () => render(),
      showNotifications
    ));
  };
  range.addEventListener('change', render);
  markCaughtUp.addEventListener('click', () => {
    try { globalThis.window?.localStorage.setItem(CATCH_UP_STORAGE_KEY, String(end)); } catch { /* The briefing remains usable without persistence. */ }
    markCaughtUp.replaceChildren(octicon('check-circle'), 'Caught up');
    markCaughtUp.setAttribute('disabled', 'true');
  });
  render();
  return h('section', { className: 'notifications-health home-catchup', 'aria-label': 'Catch-up briefing' },
    h('header', { className: 'home-catchup-header' },
      h('div', { className: 'home-catchup-controls' }, range, markCaughtUp)),
    content);
}

/**
 * @param {Record<string, unknown>[]} attentionRows
 * @param {{ runs: Record<string, unknown>[], workItems: Record<string, unknown>[], outcomes: Record<string, unknown>[], operationalValues: Record<string, unknown>[], evidenceRecords: Record<string, unknown>[] }} sources
 * @param {number} start
 * @param {number} end
 * @param {() => void} redraw
 * @param {(query?: string) => void} showNotifications
 */
function renderCatchUpContent(attentionRows, sources, start, end, redraw, showNotifications) {
  const currentOutcomes = within(sources.outcomes, start, end);
  const previousOutcomes = within(sources.outcomes, start - (end - start), start);
  const delivered = currentOutcomes.filter((row) => row['outcome-state'] === 'lifecycle-close').length;
  const previousDelivered = previousOutcomes.filter((row) => row['outcome-state'] === 'lifecycle-close').length;
  const pending = currentOutcomes.filter((row) => row['outcome-state'] === 'pending').length;
  const activeWork = sources.workItems.filter((row) => ['active', 'in-progress', 'running'].includes(String(row['lifecycle-state']))).length;
  const activeRuns = sources.runs.filter((row) => ACTIVE_STATUSES.has(String(row['run-status']))).length;
  const running = activeWork || activeRuns;
  const currentEvidence = within(sources.evidenceRecords, start, end);
  const acceptedEvidence = currentEvidence.filter((row) => row['verification-state'] === 'accepted').length;
  const evidencePercent = currentEvidence.length > 0 ? acceptedEvidence / currentEvidence.length : null;
  const value = valueSeries(sources.operationalValues, start, end);
  const valueDelta = value.length > 1 ? value[value.length - 1] - value[0] : null;
  const stories = catchUpStories(attentionRows, currentOutcomes, sources.operationalValues, start, end);
  const queueState = readCatchUpQueueState();
  const { queue, size, seen } = buildCatchUpQueue(stories, queueState);
  queueState.queue = queue;
  queueState.size = size;
  queueState.seen = seen;
  writeCatchUpQueueState(queueState);
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const queuedStories = /** @type {typeof stories} */ (queue.map((id) => storiesById.get(id)).filter((story) => story !== undefined));
  /** @param {string} storyId @param {'done' | 'later'} bucket */
  const processStory = (storyId, bucket) => {
    queueState[bucket].add(storyId);
    queueState.queue = queueState.queue.filter((id) => id !== storyId);
    writeCatchUpQueueState(queueState);
    redraw();
  };
  return h('div', null,
    h('dl', { className: 'home-catchup-metrics', 'aria-label': 'Catch-up summary' },
      catchUpMetric(String(delivered), 'outcomes delivered', 'success'),
      catchUpMetric(String(pending), 'awaiting review', pending > 0 ? 'attention' : 'neutral'),
      catchUpMetric(String(running), 'running now', running > 0 ? 'accent' : 'neutral'),
      catchUpMetric(formatRoundedPercent(evidencePercent), 'evidence accepted', 'neutral')),
    h('div', { className: 'home-catchup-charts' },
      renderOutcomeMomentum(currentOutcomes, start, end, delivered, previousDelivered),
      h('div', { className: 'home-catchup-side-charts' },
        renderWorkNow(sources.workItems, running, pending),
        renderValueGain(value, valueDelta))),
    h('section', { className: 'home-catchup-stories', 'aria-labelledby': 'home-catchup-stories-title' },
      h('header', null,
        h('h3', { id: 'home-catchup-stories-title' }, 'What changed'),
        h('span', null, size > 0 ? `${queuedStories.length} of ${size} remaining` : `${queuedStories.length} highlight${queuedStories.length === 1 ? '' : 's'}`)),
      queuedStories.length > 0
        ? h('div', { className: 'home-story-rail' }, ...queuedStories.slice(0, 4).map((story) => renderCatchUpStory(story, processStory)))
        : size > 0
          ? renderCaughtUp(queueState.later.size, showNotifications)
          : h('p', { className: 'home-catchup-quiet' }, 'No meaningful state changes were observed in this interval.')),
    h('section', { className: 'home-catchup-mobile', 'aria-labelledby': 'home-catchup-mobile-title' },
      h('header', null,
        h('h3', { id: 'home-catchup-mobile-title' }, 'Catch Up'),
        h('span', { className: 'home-catchup-mobile-progress', 'aria-live': 'polite', tabindex: '-1' }, size > 0
          ? `${Math.min(size, size - queuedStories.length + 1)} of ${size}`
          : 'No highlights')),
      queuedStories.length > 0
        ? renderMobileCatchUpStory(queuedStories[0], processStory)
        : size > 0
          ? renderCaughtUp(queueState.later.size, showNotifications)
          : h('p', { className: 'home-catchup-quiet' }, 'No meaningful state changes were observed in this interval.')));
}

/** @param {number} laterCount @param {(query?: string) => void} showNotifications */
function renderCaughtUp(laterCount, showNotifications) {
  const label = laterCount > 0 ? 'View Later in Notifications' : 'Back to Notifications';
  return h('p', { className: 'home-catchup-quiet' },
    h('strong', null, '✓ You are caught up'),
    ' ',
    h('a', {
      href: '#page-overview',
      onClick: /** @param {MouseEvent} event */ (event) => {
        event.preventDefault();
        showNotifications(laterCount > 0 ? 'is:later' : '');
      }
    }, label));
}

/** @param {Record<string, unknown>[]} rows @param {number} start @param {number} end */
function within(rows, start, end) {
  return rows.filter((row) => {
    const timestamp = observedAt(row);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

/** @param {Record<string, unknown>} row */
function observedAt(row) {
  return Date.parse(String(row['observed-at'] || row['published-at'] || row['ended-at'] || row['started-at'] || ''));
}

/** @param {Record<string, unknown>[]} rows */
function latestObservedAt(rows) {
  const timestamps = rows.map(observedAt).filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
}

function readLastCatchUp() {
  try {
    const timestamp = Number(globalThis.window?.localStorage.getItem(CATCH_UP_STORAGE_KEY));
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  } catch {
    return null;
  }
}

/** @param {string} value @param {string} label @param {string} tone */
function catchUpMetric(value, label, tone) {
  return h('div', { className: `home-catchup-metric home-catchup-metric-${tone}` }, h('dd', null, value), h('dt', null, label));
}

/** @param {Record<string, unknown>[]} outcomes @param {number} start @param {number} end @param {number} delivered @param {number} previousDelivered */
function renderOutcomeMomentum(outcomes, start, end, delivered, previousDelivered) {
  const days = timeBuckets(start, end, 10);
  for (const outcome of outcomes) {
    const timestamp = observedAt(outcome);
    const bucket = days.find((day) => timestamp >= day.start && timestamp < day.end);
    if (!bucket) continue;
    outcome['outcome-state'] === 'lifecycle-close' ? bucket.delivered += 1 : outcome['outcome-state'] === 'pending' ? bucket.pending += 1 : bucket.other += 1;
  }
  const max = Math.max(1, ...days.map((day) => day.delivered + day.pending + day.other));
  const gain = previousDelivered > 0 ? Math.round(((delivered - previousDelivered) / previousDelivered) * 100) : null;
  return h('section', { className: 'home-momentum-panel' },
    h('header', null,
      h('div', null, renderOriginBadge({ label: 'Work', icon: 'project-roadmap', tone: 'work' }), h('h3', null, 'Outcome momentum')),
      h('strong', { className: gain !== null && gain >= 0 ? 'home-positive' : '' }, gain === null ? `${delivered} delivered` : `${gain >= 0 ? '+' : ''}${gain}%`),
      h('small', null, gain === null ? 'this interval' : 'vs previous interval')),
    h('svg', { className: 'home-momentum-chart', viewBox: '0 0 520 126', role: 'img', 'aria-label': `${delivered} delivered outcomes and ${outcomes.filter((row) => row['outcome-state'] === 'pending').length} pending outcomes` },
      ...[24, 54, 84, 114].map((y) => h('line', { x1: 8, y1: y, x2: 512, y2: y, className: 'home-chart-grid' })),
      ...days.flatMap((day, index) => {
        const x = 14 + index * 50;
        const deliveredHeight = (day.delivered / max) * 92;
        const pendingHeight = (day.pending / max) * 92;
        return [
          h('rect', { x, y: 114 - deliveredHeight, width: 30, height: Math.max(0, deliveredHeight), rx: 3, className: 'home-chart-delivered' }),
          h('rect', { x, y: 114 - deliveredHeight - pendingHeight, width: 30, height: Math.max(0, pendingHeight), rx: 3, className: 'home-chart-pending' })
        ];
      })),
    h('div', { className: 'home-chart-legend' },
      h('span', null, h('i', { className: 'home-legend-delivered' }), 'Delivered'),
      h('span', null, h('i', { className: 'home-legend-pending' }), 'Needs review')));
}

/** @param {number} start @param {number} end @param {number} count @returns {{ start: number, end: number, delivered: number, pending: number, other: number }[]} */
function timeBuckets(start, end, count) {
  const width = Math.max(1, (end - start) / count);
  return Array.from({ length: count }, (_, index) => ({ start: start + index * width, end: start + (index + 1) * width, delivered: 0, pending: 0, other: 0 }));
}

/**
 * Renders the shared `<section class="home-mini-chart">` header-plus-body
 * pattern used by the "Work now" and "Value gained" catch-up side charts,
 * which both pair an origin badge and title with a single body element.
 * @param {{ label: string, icon: string, tone: string }} origin
 * @param {string} title
 * @param {Node} body
 * @returns {HTMLElement}
 */
function renderMiniChartPanel(origin, title, body) {
  return h('section', { className: 'home-mini-chart' },
    h('header', null, renderOriginBadge(origin), h('h3', null, title)),
    body);
}

/** @param {Record<string, unknown>[]} workItems @param {number} running @param {number} pending */
function renderWorkNow(workItems, running, pending) {
  const blocked = workItems.filter((row) => row['lifecycle-state'] === 'blocked').length;
  const total = Math.max(1, running + pending + blocked);
  return renderMiniChartPanel({ label: 'Work', icon: 'workflow', tone: 'work' }, 'Work now',
    h('div', { className: 'home-work-now' },
      h('div', { className: 'home-work-ring', style: `--running:${(running / total) * 360}deg;--review:${((running + pending) / total) * 360}deg` }, h('strong', null, String(running)), h('span', null, 'running')),
      h('dl', null,
        h('div', null, h('dt', null, 'Needs review'), h('dd', null, String(pending))),
        h('div', null, h('dt', null, 'Blocked'), h('dd', null, String(blocked))))));
}

/** @param {Record<string, unknown>[]} rows @param {number} start @param {number} end */
function valueSeries(rows, start, end) {
  const buckets = timeBuckets(start, end, 10).map((bucket) => ({ ...bucket, values: /** @type {number[]} */ ([]) }));
  for (const row of rows) {
    if (row['maturity-status'] !== 'matured') continue;
    const timestamp = observedAt(row);
    const value = Number(row['operational-value']);
    const bucket = buckets.find((entry) => timestamp >= entry.start && timestamp < entry.end);
    if (bucket && Number.isFinite(value)) bucket.values.push(value);
  }
  return buckets.filter((bucket) => bucket.values.length > 0).map((bucket) => bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length);
}

/** @param {number[]} values @param {number | null} delta */
function renderValueGain(values, delta) {
  const points = values.length > 0 ? values : [0];
  const coordinates = points.map((value, index) => `${8 + index * (104 / Math.max(1, points.length - 1))},${42 - Math.max(0, Math.min(1, value)) * 32}`).join(' ');
  return renderMiniChartPanel({ label: 'Insights', icon: 'graph', tone: 'insights' }, 'Value gained',
    h('div', { className: 'home-value-gain' },
      h('strong', { className: delta !== null && delta >= 0 ? 'home-positive' : '' }, delta === null ? '—' : `${delta >= 0 ? '+' : ''}${Math.round(delta * 100)} pts`),
      h('svg', { viewBox: '0 0 120 48', role: 'img', 'aria-label': delta === null ? 'Operational value change unavailable' : `Operational value changed ${Math.round(delta * 100)} points` },
        h('line', { x1: 8, y1: 42, x2: 112, y2: 42, className: 'home-chart-grid' }),
        h('polyline', { points: coordinates, className: 'home-value-line' }))));
}

/**
 * @param {Record<string, unknown>[]} attentionRows
 * @param {Record<string, unknown>[]} outcomes
 * @param {Record<string, unknown>[]} operationalValues
 * @param {number} start
 * @param {number} end
 */
function catchUpStories(attentionRows, outcomes, operationalValues, start, end) {
  const leadAttention = attentionRows[0];
  const agentSmell = attentionRows.find((row) => row['signal-type'] === 'agent-smell' && row !== leadAttention);
  /** @type {Record<string, unknown>[]} */
  const selectedAttention = [];
  if (leadAttention) selectedAttention.push(leadAttention);
  if (agentSmell) selectedAttention.push(agentSmell);
  const attention = selectedAttention.map((row) => ({
    ...row,
    timestamp: end - Number(row['age-seconds'] || 0) * 1000,
    deepLink: findLink(row, 'evidence-link')?.href || ''
  }));
  const latestValue = operationalValues
    .filter((row) => row['maturity-status'] === 'matured' && observedAt(row) >= start && observedAt(row) <= end)
    .sort((left, right) => observedAt(right) - observedAt(left))[0];
  return normalizeNotificationStories([
    ...attention,
    ...outcomeStoryEvents(outcomes),
    ...operationalValueStoryEvents(latestValue ? [latestValue] : [])
  ]).filter((story) => Number.isFinite(story.timestamp));
}

/** @param {Record<string, unknown>[]} outcomes */
function outcomeStoryEvents(outcomes) {
  return outcomes
    .filter((row) => ['pending', 'lifecycle-close'].includes(String(row['outcome-state'])))
    .map((row) => {
      const outcomeId = String(row['safe-output'] || row['outcome-number'] || '');
      return {
        ...row,
        ...(outcomeId ? { 'event-id': `outcome:${outcomeId}` } : {}),
        classification: String(row['outcome-state']),
        title: String(row['outcome-title'] || row['workflow-name'] || 'Outcome observed'),
        detail: row['outcome-state'] === 'pending' ? 'A produced outcome is ready for review.' : 'A produced outcome was delivered.',
        timestamp: observedAt(row),
        deepLink: findLink(row, 'external-link')?.href || findLink(row, 'evidence-link')?.href || ''
      };
    });
}

/** @param {Record<string, unknown>[]} operationalValues */
function operationalValueStoryEvents(operationalValues) {
  return operationalValues.map((row) => ({
    ...row,
    ...(row['observation-id'] || row.workflow || row['operational-value-definition']
      ? { 'event-id': `operational-value:${String(row['observation-id'] || row.workflow || row['operational-value-definition'])}` }
      : {}),
    classification: 'operational-value',
    title: String(row.workflow || 'Operational value measured'),
    detail: `Matured operational value reached ${formatRoundedPercent(Number(row['operational-value']))}.`,
    timestamp: observedAt(row),
    deepLink: findLink(row, 'evidence-link')?.href || '',
    objectType: 'workflow',
    objectId: String(row.workflow || row['observation-id'] || '')
  }));
}

/**
 * @param {{ id: string, classification: string, sourceType: string, title: string, detail: string, timestamp: number, deepLink: string }} story
 * @param {(storyId: string, bucket: 'done' | 'later') => void} processStory
 */
function renderCatchUpStory(story, processStory) {
  /** @param {string} label @param {string} icon @param {'done' | 'later'} bucket */
  const action = (label, icon, bucket) => h('button', {
    type: 'button', className: 'notifications-icon-button', title: label, 'aria-label': `${label} ${story.title}`,
    onClick: /** @param {MouseEvent} event */ (event) => {
      event.preventDefault();
      event.stopPropagation();
      processStory(story.id, bucket);
    }
  }, octicon(icon));
  const link = [
    renderOriginBadge(notificationOrigin({ 'signal-type': story.sourceType })),
    h('span', { className: 'home-story-copy' }, h('strong', null, story.title), h('small', null, story.detail)),
    octicon('chevron-right')
  ];
  return h('article', { className: 'home-catchup-story' },
    h(story.deepLink ? 'a' : 'span', { className: 'home-story-link', ...(story.deepLink ? { href: story.deepLink } : {}) }, ...link),
    h('span', { className: 'home-story-actions' },
      action('Save for later', 'clock', 'later'),
      action('Mark as done', 'check-circle', 'done')));
}

/**
 * @param {{ id: string, classification: string, sourceType: string, title: string, detail: string, repository: string, deepLink: string }} story
 * @param {(storyId: string, bucket: 'done' | 'later') => void} processStory
 */
function renderMobileCatchUpStory(story, processStory) {
  /** @param {string} label @param {string} icon @param {'done' | 'later'} bucket */
  const action = (label, icon, bucket) => h('button', {
    type: 'button',
    className: `home-catchup-mobile-action home-catchup-mobile-${bucket}`,
    'aria-label': `${label} ${story.title}`,
    onClick: /** @param {MouseEvent} event */ (event) => {
      const briefing = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('.home-catchup') : null;
      processStory(story.id, bucket);
      const focusTarget = briefing?.querySelector(`.home-catchup-mobile-${bucket}`)
        ?? briefing?.querySelector('.home-catchup-mobile-progress');
      if (focusTarget instanceof HTMLElement) focusTarget.focus();
    }
  }, octicon(icon), h('span', null, label));
  const card = h('article', { className: 'home-catchup-mobile-card' },
    h(story.deepLink ? 'a' : 'div', {
      className: 'home-catchup-mobile-link',
      ...(story.deepLink ? { href: story.deepLink } : {})
    },
    h('span', { className: 'home-catchup-mobile-meta' },
      h('span', { className: 'home-catchup-classification' }, catchUpClassificationLabel(story.classification)),
      renderOriginBadge(notificationOrigin({ 'signal-type': story.sourceType }))),
    h('strong', null, story.title),
    h('p', null, story.detail),
    story.repository ? h('small', null, story.repository) : null),
    h('span', { className: 'home-catchup-mobile-hint', 'aria-hidden': 'true' }, 'Swipe right for Done · left for Later'),
    h('span', { className: 'home-catchup-mobile-actions' },
      action('Later', 'clock', 'later'),
      action('Done', 'check-circle', 'done')));
  enableCatchUpSwipe(card, story.id, processStory);
  return card;
}

/** @param {HTMLElement} card @param {string} storyId @param {(storyId: string, bucket: 'done' | 'later') => void} processStory */
function enableCatchUpSwipe(card, storyId, processStory) {
  /** @type {{ pointerId: number | undefined, x: number, y: number } | null} */
  let start = null;
  let suppressClick = false;
  card.addEventListener('pointerdown', (event) => {
    const pointer = /** @type {PointerEvent} */ (event);
    if (pointer.isPrimary === false || pointer.button !== 0) return;
    start = { pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY };
    if (pointer.pointerId !== undefined) card.setPointerCapture?.(pointer.pointerId);
  });
  card.addEventListener('pointerup', (event) => {
    const pointer = /** @type {PointerEvent} */ (event);
    if (!start || (start.pointerId !== undefined && pointer.pointerId !== start.pointerId)) return;
    const horizontal = pointer.clientX - start.x;
    const vertical = pointer.clientY - start.y;
    start = null;
    if (Math.abs(horizontal) < 48 || Math.abs(horizontal) <= Math.abs(vertical)) return;
    pointer.preventDefault();
    suppressClick = true;
    processStory(storyId, horizontal > 0 ? 'done' : 'later');
  });
  card.addEventListener('pointercancel', () => {
    start = null;
  });
  card.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

/** @param {string} classification */
function catchUpClassificationLabel(classification) {
  if (classification === 'needs_you') return 'Needs you';
  if (classification === 'fyi') return 'FYI';
  return 'Update';
}

/** @param {Record<string, unknown>} row */
function notificationOrigin(row) {
  const signal = String(row.sourceType || row['signal-type'] || '').toLowerCase();
  if (signal.includes('agent') || signal.includes('security') || signal.includes('threat')) return { label: 'Operations', icon: 'copilot', tone: 'agents' };
  if (signal.includes('value') || signal.includes('evidence') || signal.includes('budget') || signal.includes('capacity')) return { label: 'Insights', icon: 'graph', tone: 'insights' };
  return { label: 'Work', icon: 'project-roadmap', tone: 'work' };
}

/** @param {{ label: string, icon: string, tone: string }} origin */
function renderOriginBadge(origin) {
  return h('span', { className: `home-origin-badge home-origin-${origin.tone}` }, octicon(origin.icon), h('span', null, origin.label));
}

/** @param {Record<string, unknown>} row @param {{ read: Set<string>, saved: Set<string>, done: Set<string> }} state @param {Set<string>} selected @param {HTMLButtonElement} bulkDone @param {() => void} render */
function renderNotification(row, state, selected, bulkDone, render) {
  const id = rowId(row);
  const deepLink = typeof row.deepLink === 'string' && row.deepLink ? { href: row.deepLink } : null;
  const link = deepLink ?? findLink(row, 'evidence-link') ?? findLink(row, 'run-link') ?? findLink(row, 'external-link');
  const unread = !hasRowState(state.read, row);
  const done = hasRowState(state.done, row);
  /** @param {string} label @param {string} icon @param {boolean} active @param {() => void} change */
  const action = (label, icon, active, change) => h('button', {
    type: 'button', className: `notifications-icon-button${active ? ' active' : ''}`,
    title: label, 'aria-label': label, 'aria-pressed': String(active), onClick: () => { change(); writeState(state); render(); }
  }, octicon(icon));
  return h('li', { className: `canonical-attention-item notification-item${unread ? ' unread' : ''}` },
    h('span', { className: 'notification-unread-dot', 'aria-label': unread ? 'Unread' : 'Read' }),
    h('input', {
      type: 'checkbox', dataset: { notificationId: id },
      'aria-label': `Select ${String(row.objective || 'notification')}`,
      onChange: /** @param {Event} event */ (event) => {
        /** @type {HTMLInputElement} */ (event.currentTarget).checked ? selected.add(id) : selected.delete(id);
        bulkDone.disabled = selected.size === 0;
      }
    }),
    renderOriginBadge(notificationOrigin(row)),
    h(link ? 'a' : 'div', { className: 'notification-content', ...(link ? { href: link.href, onClick: () => { state.read.add(id); writeState(state); } } : {}) },
      h('span', { className: 'notification-repository' }, scopeLabel(row)),
      h('strong', null, String(row.title || row.objective || 'Notification')),
      h('small', null, String(row.detail || row.reason || 'No additional detail'))),
    h('span', { className: 'notification-meta' }, String(row['expected-actor'] || ''), h('small', null, age(row))),
    h('span', { className: 'notification-actions' },
      action(unread ? 'Mark as read' : 'Mark as unread', unread ? 'check' : 'read', !unread, () => setRowState(state.read, row, unread)),
      action(hasRowState(state.saved, row) ? 'Unsave' : 'Save', 'bookmark', hasRowState(state.saved, row), () => setRowState(state.saved, row, !hasRowState(state.saved, row))),
      action(done ? 'Move to inbox' : 'Mark as done', done ? 'inbox' : 'check-circle', done, () => {
        setRowState(state.done, row, !done);
        if (!done) markCatchUpStoriesDone([id]);
      })));
}