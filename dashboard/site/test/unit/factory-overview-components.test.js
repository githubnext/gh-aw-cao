// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { state } from '../../src/reactive.js';
import { renderFactoryFloor } from '../../src/components/factory-floor.js';
import { renderFactoryHeader } from '../../src/components/factory-header.js';
import { renderFactoryRhythm } from '../../src/components/factory-rhythm.js';
import { renderFactoryStation } from '../../src/components/factory-station.js';

/**
 * @param {{ pending?: boolean, unavailable?: boolean, rows?: Record<string, unknown>[] }} [options]
 */
function binding({ pending = false, unavailable = false, rows = [] } = {}) {
  return {
    rows: () => rows,
    pending: () => pending,
    unavailable: () => unavailable
  };
}

/** @param {number} [currentOffset] @returns {Record<string, unknown>[]} */
function rhythmRows(currentOffset = 0) {
  return [{
    rhythm: {
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
        label,
        date: `2026-09-${String(7 + index).padStart(2, '0')}`,
        current: index < 3 ? index + 1 + currentOffset : 0,
        previous: 7 - index,
        reached: index < 3
      }))
    }
  }];
}

/** @param {Element | null | undefined} bar */
function barHeight(bar) {
  return bar instanceof HTMLElement ? Number.parseFloat(bar.style.height) : undefined;
}

describe('Overview component boundaries', () => {
  it('station owns pending, unavailable, linked, and detail presentation', () => {
    const controller = new AbortController();
    const stationState = state({
      pending: true,
      unavailable: false,
      label: 'Successful runs',
      value: 0,
      detail: { text: '' }
    });
    const station = renderFactoryStation('play', { href: '#page-runs', signal: controller.signal });
    station.bind(stationState.get);

    expect(station.element.getAttribute('aria-busy')).toBe('true');
    expect(station.element.classList.contains('factory-station-pending')).toBe(true);

    stationState.set({ pending: false, unavailable: false, label: 'Successful runs', value: 8, detail: { text: '2 failed' } });
    expect(station.element.querySelector('strong a')?.getAttribute('href')).toBe('#page-runs');
    expect(station.element.querySelector('strong')?.textContent).toBe('8');
    expect(station.element.querySelector('small')?.textContent).toBe('2 failed');

    stationState.set({ pending: false, unavailable: true, label: 'Successful runs', value: 0, detail: { text: '' } });
    expect(station.element.querySelector('strong')?.textContent).toBe('Unavailable');
    expect(station.element.querySelector('strong a')).toBeNull();
    controller.abort();
  });

  it('station stops reacting after its owner aborts', () => {
    const controller = new AbortController();
    const stationState = state({ pending: false, unavailable: false, label: 'Runs', value: 1, detail: { text: '' } });
    const station = renderFactoryStation('play', { signal: controller.signal });
    station.bind(stationState.get);

    expect(station.element.querySelector('strong')?.textContent).toBe('1');
    controller.abort();
    stationState.set({ pending: false, unavailable: false, label: 'Runs', value: 9, detail: { text: '' } });
    expect(station.element.querySelector('strong')?.textContent).toBe('1');
  });

  it('rhythm layers both weeks on every day with independent heights and accessible descriptions', () => {
    const controller = new AbortController();
    const rows = state(rhythmRows());
    const rendered = renderFactoryRhythm({ rows: rows.get }, { signal: controller.signal });
    const days = [...rendered.querySelectorAll('.factory-rhythm-day')];

    expect(days).toHaveLength(7);
    expect(rendered.getAttribute('aria-label')).toContain('this week and last week');
    expect([...rendered.querySelector('.factory-rhythm-heading')?.children ?? []].map((child) => child.textContent))
      .toEqual(['Campaign rhythm', 'Successful runs', 'This weekLast week']);
    expect(rendered.querySelector('.graph-widget-y-axis-label')).toBeNull();
    expect(rendered.querySelector('.graph-widget-plot.factory-rhythm-bars')).not.toBeNull();
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 1 successful run this week; 7 successful runs last week.');
    expect(days[3]?.getAttribute('aria-label')).toBe('Thu 2026-09-10: 0 successful runs this week (day not yet reached); 4 successful runs last week.');
    expect(rendered.querySelectorAll('.factory-rhythm-day-future')).toHaveLength(4);
    expect(rendered.querySelectorAll('.factory-rhythm-current')).toHaveLength(7);
    expect(rendered.querySelectorAll('.factory-rhythm-baseline')).toHaveLength(7);
    expect(barHeight(days[0]?.querySelector('.factory-rhythm-current'))).toBeCloseTo(100 / 7);
    expect(barHeight(days[0]?.querySelector('.factory-rhythm-baseline'))).toBe(100);
    expect(days[3]?.querySelector('.factory-rhythm-current')?.hidden).toBe(true);
    expect(barHeight(days[3]?.querySelector('.factory-rhythm-current'))).toBe(0);
    expect(barHeight(days[3]?.querySelector('.factory-rhythm-baseline'))).toBeCloseTo(400 / 7);

    rows.set(rhythmRows(10));
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 11 successful runs this week; 7 successful runs last week.');
    expect(barHeight(days[0]?.querySelector('.factory-rhythm-current'))).toBeCloseTo(1100 / 13);
    expect(barHeight(days[0]?.querySelector('.factory-rhythm-baseline'))).toBeCloseTo(700 / 13);
    expect(days[3]?.getAttribute('aria-label')).toContain('day not yet reached');
    expect(barHeight(days[3]?.querySelector('.factory-rhythm-baseline'))).toBeCloseTo(400 / 13);

    controller.abort();
    rows.set([]);
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 11 successful runs this week; 7 successful runs last week.');
  });

  it('rhythm retains both week indicators when the source has no data', () => {
    const controller = new AbortController();
    const rendered = renderFactoryRhythm(binding(), { signal: controller.signal });
    expect(rendered.querySelectorAll('.factory-rhythm-day')).toHaveLength(7);
    expect(rendered.querySelector('.factory-rhythm-heading strong')?.textContent).toBe('Successful runs');
    expect(rendered.querySelector('.graph-widget-y-axis-label')).toBeNull();
    expect(rendered.querySelectorAll('.factory-rhythm-bar-pair i')).toHaveLength(14);
    expect(rendered.querySelector('.factory-rhythm-day')?.getAttribute('aria-label'))
      .toBe('Mon: 0 successful runs this week (day not yet reached); 0 successful runs last week.');
    expect(rendered.querySelectorAll('.factory-rhythm-bar-pair i:not([hidden])')).toHaveLength(0);
    expect(barHeight(rendered.querySelector('.factory-rhythm-current'))).toBe(0);
    controller.abort();
  });

  it('rhythm hides zero bars independently and restores them when counts change', () => {
    const controller = new AbortController();
    const rows = state(rhythmRows());
    const rendered = renderFactoryRhythm({ rows: rows.get }, { signal: controller.signal });
    const first = rendered.querySelector('.factory-rhythm-day');
    const current = first?.querySelector('.factory-rhythm-current');
    const previous = first?.querySelector('.factory-rhythm-baseline');

    expect(current?.hidden).toBe(false);
    expect(previous?.hidden).toBe(false);
    const zeroPrevious = rhythmRows();
    zeroPrevious[0].rhythm.days[0].previous = 0;
    rows.set(zeroPrevious);
    expect(current?.hidden).toBe(false);
    expect(previous?.hidden).toBe(true);
    expect(barHeight(previous)).toBe(0);
    expect(first?.getAttribute('aria-label')).toContain('0 successful runs last week');

    rows.set(rhythmRows());
    expect(previous?.hidden).toBe(false);
    expect(barHeight(previous)).toBe(100);
    controller.abort();
  });

  it('floor composes selected stations and owns their aggregate accessible summary', () => {
    const controller = new AbortController();
    const sources = {
      'overview-campaign-station': binding({ rows: [{
        value: 2 / 3,
        'display-value': '66.7%',
        detail: '2/3 healthy campaigns',
        description: '67% campaign health',
        active: true
      }] }),
      'overview-repository-station': binding({ rows: [{
        value: 0.5,
        'display-value': '50%',
        detail: '4/6 repositories reached',
        description: '50% average repository coverage'
      }] })
    };
    const rendered = renderFactoryFloor(
      sources,
      false,
      { signal: controller.signal },
      { campaigns: 'overview-campaign-station', repositories: 'overview-repository-station' },
      ['campaigns', 'repositories']
    );

    expect([...rendered.querySelectorAll('.factory-station strong')].map((element) => element.textContent)).toEqual(['66.7%', '50%']);
    expect([...rendered.querySelectorAll('.factory-station small')].map((element) => element.textContent)).toEqual(['2/3 healthy campaigns', '4/6 repositories reached']);
    expect(rendered.classList.contains('factory-floor-active')).toBe(true);
    expect(rendered.getAttribute('aria-label')).toBe('67% campaign health, 50% average repository coverage.');
    controller.abort();
  });

  it('header presents declarative heading and rhythm composition without subtext', () => {
    const controller = new AbortController();
    const sources = {
      'overview-header-presentation': binding({ rows: [{ heading: 'Your campaigns are delivering value.' }] }),
      'overview-rhythm': binding({ rows: rhythmRows() })
    };
    const rendered = renderFactoryHeader(
      sources,
      { signal: controller.signal },
      { presentation: 'overview-header-presentation', rhythm: 'overview-rhythm' }
    );

    expect(rendered.querySelector('.factory-running')).toBeNull();
    expect(rendered.querySelector('h2')?.textContent).toBe('Your campaigns are delivering value.');
    expect(rendered.querySelector('.factory-intro-copy > p')?.hasAttribute('hidden')).toBe(true);
    expect(rendered.querySelector('.factory-rhythm')).not.toBeNull();

    controller.abort();
  });
});