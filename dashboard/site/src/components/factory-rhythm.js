import { h } from '../dom.js';
import { derived, effect } from '../reactive.js';
import { formatCount } from './count-formatters.js';

/** @typedef {{ label: string, date: string, count: number, previous: number, reached: boolean }} RhythmDay */
/** @typedef {{ rows: () => Record<string, unknown>[] }} RhythmSource */
/** @typedef {{ signal: AbortSignal }} ReactiveScope */

/**
 * @param {RhythmSource} source
 * @param {ReactiveScope} scope
 */
export function renderFactoryRhythm(source, scope) {
  const bars = h('div', { className: 'factory-rhythm-bars' });
  const rhythmDays = derived(() => rhythmPayload(source).days, { signal: scope.signal });
  const section = h(
    'section',
    {
      className: 'factory-rhythm',
      'aria-label': 'Successful Actions runs from Monday through Sunday'
    },
    h(
      'div',
      { className: 'factory-rhythm-heading' },
      h('span', {}, 'Factory rhythm'),
      h(
        'ul',
        { className: 'factory-rhythm-legend', 'aria-label': 'Factory rhythm legend' },
        h('li', {}, h('i', { className: 'factory-rhythm-legend-current', 'aria-hidden': 'true' }), 'This week'),
        h('li', {}, h('i', { className: 'factory-rhythm-legend-previous', 'aria-hidden': 'true' }), 'Last week')
      )
    ),
    bars
  );

  effect(() => {
    const days = rhythmDays.get();
    const maximum = Math.max(...days.flatMap((day) => [day.count, day.previous]), 1);
    if (bars.childElementCount !== days.length) {
      bars.replaceChildren(...days.map(() => createRhythmDay()));
    }
    for (const [index, element] of rhythmDayElements(bars).entries()) {
      const day = days[index];
      const value = day.reached ? day.count : day.previous;
      const description = rhythmDayDescription(day);
      element.classList.toggle('factory-rhythm-day-future', !day.reached);
      element.setAttribute('aria-label', description);
      element.title = description;
      const current = element.querySelector('.factory-rhythm-current');
      if (current instanceof HTMLElement) {
        current.hidden = !day.reached;
        current.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const baseline = element.querySelector('.factory-rhythm-baseline');
      if (baseline instanceof HTMLElement) {
        baseline.hidden = day.reached;
        baseline.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const label = element.querySelector('small');
      if (label) label.textContent = day.label;
    }
  }, { signal: scope.signal });

  return section;
}

/** @param {RhythmDay} day */
function rhythmDayDescription(day) {
  const count = day.reached ? day.count : day.previous;
  const period = day.reached ? 'this week' : 'last week';
  return `${day.label} ${day.date}: ${formatCount(count)} successful ${count === 1 ? 'run' : 'runs'} ${period}.`;
}

/** @param {RhythmSource} source @returns {{ days: RhythmDay[] }} */
function rhythmPayload(source) {
  const row = source.rows()[0];
  const value = row?.rhythm;
  const configured = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  const input = Array.isArray(configured.days) ? configured.days : [];
  const days = input.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const day = /** @type {Record<string, unknown>} */ (candidate);
    if (typeof day.label !== 'string' || typeof day.date !== 'string' || typeof day.reached !== 'boolean') return [];
    return [{
      label: day.label,
      date: day.date,
      count: numberField(day, 'current'),
      previous: numberField(day, 'previous'),
      reached: day.reached
    }];
  });
  return {
    days: days.length === 7
      ? days
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({
          label,
          date: '',
          count: 0,
          previous: 0,
          reached: false
        }))
  };
}

/** @param {Record<string, unknown>} row @param {string} field */
function numberField(row, field) {
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : 0;
}

/** @param {HTMLElement} bars @returns {HTMLElement[]} */
function rhythmDayElements(bars) {
  return [...bars.querySelectorAll('.factory-rhythm-day')].filter((element) => element instanceof HTMLElement);
}

function createRhythmDay() {
  return h(
    'div',
    {
      className: 'factory-rhythm-day',
      role: 'img'
    },
    h('span', { className: 'factory-rhythm-bar-pair', 'aria-hidden': 'true' },
      h('i', { className: 'factory-rhythm-baseline' }),
      h('i', { className: 'factory-rhythm-current' })
    ),
    h('small', {})
  );
}