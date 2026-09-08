import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatClockDuration } from '../view-formatters.js';
import { buildCatchUpQueue, normalizeNotificationStories } from '../notification-stories.js';
import { findLink } from './link-content.js';
import { smellMark } from './agent-marketplace-view.js';
import { renderLazyInfiniteList } from './lazy-infinite-list.js';

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

/** @returns {{ queue: string[], size: number, done: Set<string>, later: Set<string> }} */
function readCatchUpQueueState() {
  try {
    const stored = JSON.parse(globalThis.window?.localStorage.getItem(CATCH_UP_QUEUE_STORAGE_KEY) ?? '{}');
    return {
      queue: Array.isArray(stored.queue) ? stored.queue : [],
      size: Number(stored.size) || 0,
      done: new Set(Array.isArray(stored.done) ? stored.done : []),
      later: new Set(Array.isArray(stored.later) ? stored.later : [])
    };
  } catch {
    return { queue: [], size: 0, done: new Set(), later: new Set() };
  }
}

/** @param {{ queue: string[], size: number, done: Set<string>, later: Set<string> }} state */
function writeCatchUpQueueState(state) {
  try {
    globalThis.window?.localStorage.setItem(CATCH_UP_QUEUE_STORAGE_KEY, JSON.stringify({
      queue: state.queue, size: state.size, done: [...state.done], later: [...state.later]
    }));
  } catch {
    // The Catch Up queue remains usable for this page load when storage is unavailable.
  }
}

/** @param {Record<string, unknown>} row */
function rowId(row) {
  return String(row['attention-signal-id'] || `${row.scope}:${row.objective}`);
}

/** @param {Record<string, unknown>} row */
function repository(row) {
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
  return Number.isFinite(seconds) ? `${formatClockDuration(seconds * 1000)} ago` : 'Recently';
}

/** @param {Record<string, unknown>} row */
function dateGroup(row) {
  const seconds = Number(row['age-seconds']);
  if (!Number.isFinite(seconds) || seconds < 86_400) return 'Today';
  if (seconds < 604_800) return 'This week';
  return 'Older';
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} query
 * @param {{ read: Set<string>, saved: Set<string>, done: Set<string> }} state
 */
function matchesQuery(row, query, state) {
  const id = rowId(row);
  const haystack = [row.objective, row.scope, row.reason, row['expected-actor'], row['signal-type']]
    .map((value) => String(value || '').toLowerCase()).join(' ');
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every((token) => {
    if (token === 'is:unread') return !state.read.has(id);
    if (token === 'is:read') return state.read.has(id);
    if (token === 'is:saved') return state.saved.has(id);
    if (token === 'is:done') return state.done.has(id);
    if (token.startsWith('repo:')) return repository(row).toLowerCase().includes(token.slice(5));
    if (token.startsWith('actor:')) return String(row['expected-actor'] || '').toLowerCase().includes(token.slice(6));
    return haystack.includes(token);
  });
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ runs?: Record<string, unknown>[], workItems?: Record<string, unknown>[], outcomes?: Record<string, unknown>[], operationalValues?: Record<string, unknown>[], evidenceRecords?: Record<string, unknown>[] }} sources
 */
export function renderNotificationsInbox(rows, sources = {}) {
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
  const count = h('span', { className: 'notifications-result-count', 'aria-live': 'polite' });
  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search', value: 'is:unread', placeholder: 'Filter notifications',
    'aria-label': 'Filter notifications', spellcheck: 'false'
  }));
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
    let visible = rows.filter((row) => matchesQuery(row, search.value, state));
    visible = [...visible].sort((left, right) => {
      if (sort.value === 'priority') return Number(left.priority || 99) - Number(right.priority || 99);
      const delta = Number(left['age-seconds'] || 0) - Number(right['age-seconds'] || 0);
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
  const all = h('button', { type: 'button', onClick: () => { search.value = search.value.replace(/\bis:(read|unread)\b/g, '').trim(); render(); } }, 'All');
  const unread = h('button', { type: 'button', onClick: () => { search.value = `${search.value.replace(/\bis:(read|unread)\b/g, '').trim()} is:unread`.trim(); render(); } }, 'Unread');
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
    writeState(state);
    render();
  });
  render();

  const main = h('div', { className: 'notifications-main' },
      h('div', { className: 'notifications-toolbar' },
        h('div', { className: 'notifications-state-tabs' }, all, unread),
        h('label', { className: 'notifications-search' }, octicon('search'), search),
        h('label', { className: 'notifications-select' }, h('span', null, 'Sort by:'), sort),
        h('label', { className: 'notifications-select' }, h('span', null, 'Group by:'), group)),
      h('div', { className: 'notifications-selection-bar' },
        h('label', null, selectAll, h('span', null, 'Select all')),
        count,
        bulkDone),
      list);
  const health = renderOperationalPulse(rows, sources);
  return h('div', { className: `notifications-inbox${rows.length > 0 ? ' has-notifications' : ' is-clear'}` },
    health,
    main);
}

/** @param {Record<string, unknown>} row */
function causeKey(row) {
  const reason = String(row.reason || 'No additional detail')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${String(row['signal-type'] || 'notification').toLowerCase()}:${reason}`;
}

/** @param {Record<string, unknown>} row */
function isHighPriority(row) {
  const consequence = String(row['consequence-tier'] || '').toLowerCase();
  return consequence === 'critical' || consequence === 'high';
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
    const cluster = h('details', { className: 'notifications-cause-cluster' },
      h('summary', { className: 'notifications-cause-summary' },
        h('span', { className: 'notification-kind' }, first?.['signal-type'] === 'agent-smell' ? smellMark() : octicon(String(first?.icon || 'issue'))),
        h('span', { className: 'notifications-cause-copy' },
          h('strong', null, String(first?.reason || 'Repeated notification cause')),
          h('small', null, `${entries.length} occurrences across ${repositories.size} ${repositories.size === 1 ? 'repository' : 'repositories'}`)),
        octicon('chevron-right', 'notifications-cause-chevron')),
      entriesList);
    cluster.addEventListener('toggle', () => {
      if (/** @type {HTMLDetailsElement} */ (cluster).open && entriesList.childElementCount === 0) {
        entriesList.replaceChildren(...entries.map((row) => renderNotification(row, state, selected, bulkDone, render)));
      }
    });
    content.push(cluster);
  }
  return content;
}

const ACTIVE_STATUSES = new Set(['queued', 'in-progress', 'in_progress', 'waiting', 'pending']);

/**
 * @param {Record<string, unknown>[]} attentionRows
 * @param {{ runs?: Record<string, unknown>[], workItems?: Record<string, unknown>[], outcomes?: Record<string, unknown>[], operationalValues?: Record<string, unknown>[], evidenceRecords?: Record<string, unknown>[] }} sources
 */
function renderOperationalPulse(attentionRows, sources) {
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
    content.replaceChildren(renderCatchUpContent(attentionRows, { runs, workItems, outcomes, operationalValues, evidenceRecords }, start, end, () => render()));
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
 */
function renderCatchUpContent(attentionRows, sources, start, end, redraw) {
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
  const evidencePercent = currentEvidence.length > 0 ? Math.round((acceptedEvidence / currentEvidence.length) * 100) : null;
  const value = valueSeries(sources.operationalValues, start, end);
  const valueDelta = value.length > 1 ? value[value.length - 1] - value[0] : null;
  const stories = catchUpStories(attentionRows, currentOutcomes, sources.operationalValues, start, end);
  const queueState = readCatchUpQueueState();
  const { queue, size } = buildCatchUpQueue(stories, queueState);
  queueState.queue = queue;
  queueState.size = size;
  writeCatchUpQueueState(queueState);
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const queuedStories = queue.map((id) => storiesById.get(id)).filter(Boolean);
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
      catchUpMetric(evidencePercent === null ? '—' : `${evidencePercent}%`, 'evidence accepted', 'neutral')),
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
        : h('p', { className: 'home-catchup-quiet' }, size > 0
          ? "You're all caught up."
          : 'No meaningful state changes were observed in this interval.')));
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

/** @param {Record<string, unknown>[]} workItems @param {number} running @param {number} pending */
function renderWorkNow(workItems, running, pending) {
  const blocked = workItems.filter((row) => row['lifecycle-state'] === 'blocked').length;
  const total = Math.max(1, running + pending + blocked);
  return h('section', { className: 'home-mini-chart' },
    h('header', null, renderOriginBadge({ label: 'Work', icon: 'workflow', tone: 'work' }), h('h3', null, 'Work now')),
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
  return h('section', { className: 'home-mini-chart' },
    h('header', null, renderOriginBadge({ label: 'Insights', icon: 'graph', tone: 'insights' }), h('h3', null, 'Value gained')),
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
  const outcomeStories = outcomes
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
  const latestValue = operationalValues
    .filter((row) => row['maturity-status'] === 'matured' && observedAt(row) >= start && observedAt(row) <= end)
    .sort((left, right) => observedAt(right) - observedAt(left))[0];
  const valueStory = latestValue ? [{
    ...latestValue,
    ...(latestValue['observation-id'] || latestValue.workflow || latestValue['operational-value-definition']
      ? { 'event-id': `operational-value:${String(latestValue['observation-id'] || latestValue.workflow || latestValue['operational-value-definition'])}` }
      : {}),
    classification: 'operational-value',
    title: String(latestValue.workflow || 'Operational value measured'),
    detail: `Matured operational value reached ${Math.round(Number(latestValue['operational-value']) * 100)}%.`,
    timestamp: observedAt(latestValue),
    deepLink: findLink(latestValue, 'evidence-link')?.href || '',
    objectType: 'workflow',
    objectId: String(latestValue.workflow || latestValue['observation-id'] || '')
  }] : [];
  return normalizeNotificationStories([...attention, ...outcomeStories, ...valueStory])
    .filter((story) => Number.isFinite(story.timestamp))
    .slice(0, 4);
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
  const body = [
    renderOriginBadge(notificationOrigin({ 'signal-type': story.sourceType })),
    h('span', { className: 'home-story-copy' }, h('strong', null, story.title), h('small', null, story.detail)),
    h('span', { className: 'home-story-actions' },
      action('Save for later', 'clock', 'later'),
      action('Mark as done', 'check-circle', 'done')),
    octicon('chevron-right')
  ];
  return h(story.deepLink ? 'a' : 'article', { className: 'home-catchup-story', ...(story.deepLink ? { href: story.deepLink } : {}) }, ...body);
}

/** @param {Record<string, unknown>} row */
function notificationOrigin(row) {
  const signal = String(row['signal-type'] || '').toLowerCase();
  if (signal.includes('agent') || signal.includes('security') || signal.includes('threat')) return { label: 'Agents', icon: 'copilot', tone: 'agents' };
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
  const link = findLink(row, 'evidence-link') ?? findLink(row, 'run-link') ?? findLink(row, 'external-link');
  const unread = !state.read.has(id);
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
      h('strong', null, String(row.objective || 'Notification')),
      h('small', null, String(row.reason || 'No additional detail'))),
    h('span', { className: 'notification-meta' }, String(row['expected-actor'] || ''), h('small', null, age(row))),
    h('span', { className: 'notification-actions' },
      action(unread ? 'Mark as read' : 'Mark as unread', unread ? 'check' : 'read', !unread, () => unread ? state.read.add(id) : state.read.delete(id)),
      action(state.saved.has(id) ? 'Unsave' : 'Save', 'bookmark', state.saved.has(id), () => state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id)),
      action(state.done.has(id) ? 'Move to inbox' : 'Mark as done', state.done.has(id) ? 'inbox' : 'check-circle', state.done.has(id), () => state.done.has(id) ? state.done.delete(id) : state.done.add(id))));
}