import { h } from '../dom.js';
import { formatCount } from './count-formatters.js';
import { effect } from '../reactive.js';
import { renderReactiveGraphWidget } from './graph-widget.js';

/** @typedef {{ label: string, date: string, count: number, previous: number, reached: boolean }} RhythmDay */
/** @typedef {{ rows: () => Record<string, unknown>[], pending?: () => boolean }} RhythmSource */
/** @typedef {{ signal: AbortSignal }} ReactiveScope */

/**
 * @param {RhythmSource} source
 * @param {ReactiveScope} scope
 */
export function renderFactoryRhythm(source, scope) {
  const rendered = renderReactiveGraphWidget({
    className: 'factory-rhythm',
    headingClassName: 'factory-rhythm-heading',
    legendClassName: 'factory-rhythm-legend',
    plotClassName: 'factory-rhythm-bars',
    title: 'Campaign rhythm',
    ariaLabel: 'Successful Actions runs this week and last week from Monday through Sunday',
    legendLabel: 'Campaign rhythm legend',
    legend: [
      { label: 'This week', className: 'factory-rhythm-legend-current' },
      { label: 'Last week', className: 'factory-rhythm-legend-previous' }
    ],
    items: () => {
      const days = rhythmPayload(source).days;
      const maximum = Math.max(...days.flatMap((day) => [day.count, day.previous]), 1);
      return days.map((day) => ({
        ...day,
        currentHeight: Math.max(5, day.count / maximum * 100),
        previousHeight: Math.max(5, day.previous / maximum * 100)
      }));
    },
    key: (day) => day.label,
    renderItem: () => createRhythmDay(),
    updateItem: (element, day) => {
      const description = rhythmDayDescription(day);
      element.classList.toggle('factory-rhythm-day-future', !day.reached);
      element.setAttribute('aria-label', description);
      element.title = description;
      const current = element.querySelector('.factory-rhythm-current');
      if (current instanceof HTMLElement) {
        current.style.height = `${day.currentHeight}%`;
      }
      const baseline = element.querySelector('.factory-rhythm-baseline');
      if (baseline instanceof HTMLElement) {
        baseline.style.height = `${day.previousHeight}%`;
      }
      const label = element.querySelector('small');
      if (label) label.textContent = day.label;
    },
    signal: scope.signal
  });
  effect(() => {
    const pending = source.pending?.() ?? false;
    rendered.classList.toggle('factory-rhythm-pending', pending);
    rendered.toggleAttribute('aria-busy', pending);
  }, { signal: scope.signal });
  return rendered;
}

/** @param {RhythmDay} day */
function rhythmDayDescription(day) {
  const current = `${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'} this week`;
  const previous = `${formatCount(day.previous)} successful ${day.previous === 1 ? 'run' : 'runs'} last week`;
  return `${day.label}${day.date ? ` ${day.date}` : ''}: ${current}${day.reached ? '' : ' (day not yet reached)'}; ${previous}.`;
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