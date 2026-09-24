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
        current: index + 1 + currentOffset,
        previous: 7 - index,
        reached: index < 3
      }))
    }
  }];
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

  it('rhythm owns the seven-day chart, period selection, and accessible descriptions', () => {
    const controller = new AbortController();
    const rows = state(rhythmRows());
    const rendered = renderFactoryRhythm({ rows: rows.get }, { signal: controller.signal });
    const days = [...rendered.querySelectorAll('.factory-rhythm-day')];

    expect(days).toHaveLength(7);
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 1 successful run this week.');
    expect(days[3]?.getAttribute('aria-label')).toBe('Thu 2026-09-10: 4 successful runs last week.');
    expect(rendered.querySelectorAll('.factory-rhythm-day-future')).toHaveLength(4);

    rows.set(rhythmRows(10));
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 11 successful runs this week.');

    controller.abort();
    rows.set([]);
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 11 successful runs this week.');
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