import { h } from '../dom.js';
import { debounce } from '../debounce.js';
import { dashboardHorizonHours, formatDashboardHorizon } from '../horizon.js';
import { octicon } from '../octicons.js';
import { renderCountBadge, renderLabeledControl } from './ui-primitives.js';

/** @typedef {{ range: string, start: string, end: string }} TimeWindow */
const FILTER_DEBOUNCE_MS = 500;
const TIME_RANGE_OPTIONS = ['1h', '6h', '24h', '3d', '1w', '2w', '4w', '30d'];
const MODE_OPTIONS = ['review', 'live', 'unknown'];
const ALL_RECORDED = 'all';
const TIME_WINDOW_SELECT_LABEL = 'Time window';
export const HORIZON_FILTER_STORAGE_KEY = 'central-agentic-ops.dashboard.horizon-filter-settings';

/**
 * @param {(filters: Map<string, string[]>, timeWindow?: TimeWindow) => void} onChange
 * @param {{ defaultRange?: string, referenceEnd?: string }} [options]
 * @returns {HTMLElement}
 */
export function renderFilterBar(onChange, options = {}) {
  const persisted = readHorizonSettings();
  const filters = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search',
    value: typeof persisted.filters === 'string' ? persisted.filters : '',
    'aria-label': 'Current filters',
    spellcheck: 'false'
  }));
  const count = renderCountBadge(0, '0 filters');
  const applyFilters = debounce(onChange, FILTER_DEBOUNCE_MS);
  /** @type {ReturnType<typeof renderHorizonControl>} */
  let horizonControl;
  const emit = () => {
    applyFilters.cancel();
    stripModeTokens();
    const parsed = parseFilters(filters.value);
    parsed.set('mode', horizonControl.modes());
    updateCount(parsed);
    onChange(parsed, horizonControl.value());
  };
  horizonControl = renderHorizonControl(options.defaultRange ?? ALL_RECORDED, options.referenceEnd, emit);
  const root = h(
    'div',
    { className: 'toolbar filter-bar', 'aria-label': 'Dashboard filters' },
    h(
      'div',
      { className: 'filter-tuning-controls' },
      h(
        'div',
        { className: 'filter-control' },
        filters,
        h('span', { className: 'search-control', 'aria-hidden': 'true' }, octicon('eye')),
        count
      ),
      horizonControl.element
    )
  );
  /** @param {boolean} expanded */
  const setExpanded = (expanded) => {
    root.querySelector('.horizon-toggle')?.setAttribute('aria-expanded', String(expanded));
    root.classList.toggle('filter-bar-expanded', expanded);
  };
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.horizon-toggle')) return;
    const toggle = root.querySelector('.horizon-toggle');
    setExpanded(toggle?.getAttribute('aria-expanded') !== 'true');
  });
  root.addEventListener('keydown', (event) => {
    const toggle = root.querySelector('.horizon-toggle');
    if (event.key !== 'Escape' || toggle?.getAttribute('aria-expanded') !== 'true') return;
    setExpanded(false);
    if (toggle instanceof HTMLElement) toggle.focus();
    event.stopPropagation();
  });
  filters.addEventListener('input', () => {
    stripModeTokens();
    persistFilterText(filters.value);
    const parsed = parseFilters(filters.value);
    parsed.set('mode', horizonControl.modes());
    updateCount(parsed);
    applyFilters(parsed, horizonControl.value());
  });
  /** Strips `mode:` / `rollout-mode:` tokens from the freeform filter input, since applied
   * mode values always come from the horizon control's checkboxes, not this text field. */
  function stripModeTokens() {
    const cursor = filters.selectionStart;
    const nextValue = filters.value
      .split(/\s+/)
      .filter((token) => {
        const separator = token.indexOf(':');
        const field = separator > 0 ? token.slice(0, separator) : '';
        return field !== 'mode' && field !== 'rollout-mode';
      })
      .join(' ');
    if (nextValue !== filters.value) {
      filters.value = nextValue;
      if (cursor !== null) {
        const nextCursor = Math.min(cursor, nextValue.length);
        filters.setSelectionRange(nextCursor, nextCursor);
      }
    }
  }
  /** @param {Map<string, string[]>} parsed */
  function updateCount(parsed) {
    const filterCount = [...parsed.values()].reduce((total, values) => total + values.length, 0);
    count.textContent = String(filterCount);
    count.setAttribute('aria-label', `${filterCount} filters`);
  }
  const initialFilters = parseFilters(filters.value);
  initialFilters.set('mode', horizonControl.modes());
  updateCount(initialFilters);
  const persistedModes = Array.isArray(persisted.modes)
    ? [...new Set(persisted.modes.filter((mode) => MODE_OPTIONS.includes(mode)))]
    : MODE_OPTIONS;
  const hasModeOverride = Array.isArray(persisted.modes)
    && (persistedModes.length > 0 || persisted.modes.length === 0)
    && (persistedModes.length !== MODE_OPTIONS.length
      || persistedModes.some((mode, index) => mode !== MODE_OPTIONS[index]));
  const hasCustomizedSettings = filters.value.length > 0
    || (typeof persisted.range === 'string' && persisted.range !== (options.defaultRange ?? ALL_RECORDED))
    || hasModeOverride;
  if (hasCustomizedSettings) queueMicrotask(emit);
  return root;
}

/**
 * Closes an expanded horizon control when a click occurs outside its filter bar.
 * @param {HTMLElement} root
 */
export function enableHorizonOutsideClickDismissal(root) {
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const filterBar = root.querySelector('.filter-bar-expanded');
    if (!(filterBar instanceof HTMLElement) || filterBar.contains(event.target)) return;
    filterBar.querySelector('.horizon-toggle')?.setAttribute('aria-expanded', 'false');
    filterBar.classList.remove('filter-bar-expanded');
  });
}

/**
 * @param {string} defaultRange
 * @param {string | undefined} referenceEnd
 * @param {() => void} onChange
 */
function renderHorizonControl(defaultRange, referenceEnd, onChange) {
  const persisted = readHorizonSettings();
  let range = typeof persisted.range === 'string' ? persisted.range : defaultRange;
  if (range === 'All recorded') range = ALL_RECORDED;
  if (!TIME_RANGE_OPTIONS.includes(range) && range !== 'custom' && range !== ALL_RECORDED) range = ALL_RECORDED;
  const initialWindow = relativeTimeWindow(
    range === 'custom' || range === ALL_RECORDED ? '1w' : range,
    referenceEnd
  );
  const persistedStart = typeof persisted.start === 'string' ? persisted.start : null;
  const persistedEnd = typeof persisted.end === 'string' ? persisted.end : null;
  if (range === 'custom' && !validTimeWindow(persistedStart, persistedEnd)) range = defaultRange;
  let persistedModes = MODE_OPTIONS;
  if (Array.isArray(persisted.modes)) {
    const validModes = [...new Set(persisted.modes.filter((mode) => MODE_OPTIONS.includes(mode)))];
    if (validModes.length > 0 || persisted.modes.length === 0) {
      persistedModes = validModes;
    }
  }

  const select = /** @type {HTMLSelectElement} */ (h(
    'select',
    { 'aria-label': TIME_WINDOW_SELECT_LABEL },
    ...TIME_RANGE_OPTIONS.map((value) => h('option', { value }, `Last ${formatDashboardHorizon(value)}`)),
    h('option', { value: ALL_RECORDED }, 'All time'),
    h('option', { value: 'custom' }, 'Custom range')
  ));
  select.value = range;
  const start = /** @type {HTMLInputElement} */ (h('input', {
    type: 'datetime-local',
    'aria-label': 'Window start time',
    value: localDateTimeValue(range === 'custom' ? persistedStart : initialWindow.start)
  }));
  const end = /** @type {HTMLInputElement} */ (h('input', {
    type: 'datetime-local',
    'aria-label': 'Window stop time',
    value: localDateTimeValue(range === 'custom' ? persistedEnd : initialWindow.end)
  }));
  const applyCustomRange = h('button', { type: 'button' }, 'Apply');
  const modeInputs = MODE_OPTIONS.map((mode) => /** @type {HTMLInputElement} */ (h('input', {
    type: 'checkbox',
    value: mode,
    checked: persistedModes.includes(mode)
  })));

  const value = () => {
    if (select.value === ALL_RECORDED) return undefined;
    if (select.value !== 'custom') return relativeTimeWindow(select.value, referenceEnd);
    const customStart = isoDateTimeValue(start.value);
    const customEnd = isoDateTimeValue(end.value);
    return validTimeWindow(customStart, customEnd)
      ? { range: 'custom', start: customStart, end: customEnd }
      : undefined;
  };
  const modes = () => modeInputs.filter((input) => input.checked).map((input) => input.value);
  const persist = () => {
    const savedFilters = readHorizonSettings().filters;
    /** @type {{ range: string, modes: string[], filters?: string, start?: string, end?: string }} */
    const settings = {
      range: select.value,
      modes: modes(),
      ...(typeof savedFilters === 'string' && savedFilters ? { filters: savedFilters } : {})
    };
    if (select.value === 'custom') {
      const selected = value();
      if (selected) {
        settings.start = selected.start;
        settings.end = selected.end;
      }
    }
    try {
      globalThis.window?.localStorage?.setItem(HORIZON_FILTER_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // The filters still work for the current page when storage is unavailable.
    }
  };
  const updateValidity = () => {
    const invalid = select.value === 'custom' && !value();
    start.setAttribute('aria-invalid', String(invalid));
    end.setAttribute('aria-invalid', String(invalid));
    return !invalid;
  };
  select.addEventListener('change', () => {
    if (select.value !== 'custom') {
      const selected = relativeTimeWindow(select.value, referenceEnd);
      start.value = localDateTimeValue(selected.start);
      end.value = localDateTimeValue(selected.end);
    }
    updateValidity();
    persist();
    onChange();
  });
  for (const input of [start, end]) {
    input.addEventListener('change', () => {
      select.value = 'custom';
      updateValidity();
    });
  }
  applyCustomRange.addEventListener('click', () => {
    select.value = 'custom';
    if (!updateValidity()) return;
    persist();
    onChange();
  });
  for (const input of modeInputs) {
    input.addEventListener('change', () => {
      persist();
      onChange();
    });
  }

  return {
    element: h(
      'div',
      { className: 'time-window-control', 'aria-label': 'Evidence window' },
      renderLabeledControl('Window', select, { prefix: octicon('clock') }),
      h(
        'fieldset',
        { className: 'mode-filter-control' },
        h('legend', null, 'Modes'),
        ...modeInputs.map((input, index) => h('label', null, input, MODE_OPTIONS[index]))
      ),
      renderLabeledControl('Start', start),
      renderLabeledControl('Stop', end),
      applyCustomRange
    ),
    value,
    modes
  };
}

/** @param {string} filters */
function persistFilterText(filters) {
  try {
    const settings = readHorizonSettings();
    if (filters) settings.filters = filters;
    else delete settings.filters;
    globalThis.window?.localStorage?.setItem(HORIZON_FILTER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The filters still work for the current page when storage is unavailable.
  }
}

/** @returns {{ range?: unknown, modes?: unknown, start?: unknown, end?: unknown, filters?: unknown }} */
function readHorizonSettings() {
  try {
    const value = JSON.parse(globalThis.window?.localStorage?.getItem(HORIZON_FILTER_STORAGE_KEY) ?? 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Reports whether the dashboard's persisted (or otherwise effective)
 * time-window range currently narrows results away from "All time". A table
 * view with zero rows uses this to distinguish "no data was ever recorded"
 * from "a time window filter is hiding recorded rows" and offer an
 * accessible {@link clearTimeWindowFilter} action instead of leaving
 * operators to guess why an otherwise populated source renders empty.
 * @param {string} [defaultRange]
 * @returns {boolean}
 */
export function isTimeWindowFilterActive(defaultRange = ALL_RECORDED) {
  const persisted = readHorizonSettings();
  const range = typeof persisted.range === 'string' && persisted.range.length > 0 ? persisted.range : defaultRange;
  return (range === 'All recorded' ? ALL_RECORDED : range) !== ALL_RECORDED;
}

/**
 * Resets the rendered time-window control (scoped to `root`, defaulting to
 * the whole document) to "All time" and dispatches the same `change` event
 * the control's own select emits, so the existing persistence and
 * re-render wiring in {@link renderHorizonControl} runs unchanged. A no-op
 * when no time-window control is present in `root`, or it is already
 * cleared. Callers that live inside one dashboard page should scope `root`
 * to that page's container so this only clears the visible control.
 * @param {ParentNode} [root]
 */
export function clearTimeWindowFilter(root = globalThis.document) {
  const select = root?.querySelector?.(`[aria-label="${TIME_WINDOW_SELECT_LABEL}"]`);
  if (!(select instanceof HTMLSelectElement) || select.value === ALL_RECORDED) return;
  select.value = ALL_RECORDED;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** @param {string} range @param {string | undefined} referenceEnd @returns {TimeWindow} */
export function relativeTimeWindow(range, referenceEnd) {
  const parsedEnd = Date.parse(referenceEnd ?? '');
  const end = Number.isFinite(parsedEnd) ? parsedEnd : Date.now();
  let hours;
  try {
    hours = dashboardHorizonHours(range);
  } catch {
    hours = dashboardHorizonHours('1w');
  }
  const start = end - hours * 3_600_000;
  return { range, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** @param {string | null | undefined} start @param {string | null | undefined} end */
function validTimeWindow(start, end) {
  const startTime = Date.parse(start ?? '');
  const endTime = Date.parse(end ?? '');
  return Number.isFinite(startTime) && Number.isFinite(endTime) && startTime < endTime;
}

/** @param {string | null | undefined} value */
function localDateTimeValue(value) {
  const instant = Date.parse(value ?? '');
  if (!Number.isFinite(instant)) return '';
  const date = new Date(instant);
  return new Date(instant - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** @param {string} value */
function isoDateTimeValue(value) {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : '';
}

/**
 * @param {string} input
 * @returns {Map<string, string[]>}
 */
export function parseFilters(input) {
  /** @type {Map<string, Set<string>>} */
  const parsed = new Map();
  for (const token of input.trim().split(/\s+/)) {
    const separator = token.indexOf(':');
    if (separator < 1 || separator === token.length - 1) continue;
    const field = token.slice(0, separator);
    const value = token.slice(separator + 1);
    const values = parsed.get(field) ?? new Set();
    values.add(value);
    parsed.set(field, values);
  }
  return new Map([...parsed].map(([field, values]) => [field, [...values]]));
}
