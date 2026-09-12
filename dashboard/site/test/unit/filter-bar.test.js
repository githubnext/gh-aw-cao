// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HORIZON_FILTER_STORAGE_KEY,
  clearTimeWindowFilter,
  enableHorizonOutsideClickDismissal,
  isTimeWindowFilterActive,
  relativeTimeWindow,
  renderFilterBar,
  setTimeWindowFilter,
  setTimeWindowRange
} from '../../src/components/filter-bar.js';

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

describe('time-window filter bar', () => {
  it('defaults to all time', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange);
    document.body.append(filterBar);
    await Promise.resolve();

    expect(/** @type {HTMLSelectElement} */ (
      filterBar.querySelector('[aria-label="Time window"]')
    ).value).toBe('all');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('anchors relative windows to the latest source timestamp', () => {
    expect(relativeTimeWindow('24h', '2026-09-04T12:00:00Z')).toEqual({
      range: '24h',
      start: '2026-09-03T12:00:00.000Z',
      end: '2026-09-04T12:00:00.000Z'
    });
  });

  it('emits preset and custom start/end windows', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange, {
      defaultRange: '24h',
      referenceEnd: '2026-09-04T12:00:00Z'
    });
    document.body.append(filterBar);
    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();

    const select = /** @type {HTMLSelectElement} */ (filterBar.querySelector('[aria-label="Time window"]'));
    select.value = '6h';
    select.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(new Map([['mode', ['review', 'live', 'unknown']]]), {
      range: '6h',
      start: '2026-09-04T06:00:00.000Z',
      end: '2026-09-04T12:00:00.000Z'
    });

    const start = /** @type {HTMLInputElement} */ (filterBar.querySelector('[aria-label="Window start time"]'));
    const end = /** @type {HTMLInputElement} */ (filterBar.querySelector('[aria-label="Window stop time"]'));
    start.value = '2026-09-04T08:00';
    end.value = '2026-09-04T10:00';
    start.dispatchEvent(new Event('change'));
    [...filterBar.querySelectorAll('button')].find((button) => button.textContent === 'Apply')?.click();

    const selected = onChange.mock.calls.at(-1)?.[1];
    expect(selected.range).toBe('custom');
    expect(Date.parse(selected.end) - Date.parse(selected.start)).toBe(2 * 3_600_000);
    expect(JSON.parse(window.localStorage.getItem(HORIZON_FILTER_STORAGE_KEY) ?? '{}')).toMatchObject({
      range: 'custom',
      modes: ['review', 'live', 'unknown']
    });
  });

  it('keeps filters interactive when localStorage is unavailable', async () => {
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    try {
      const onChange = vi.fn();
      const filterBar = renderFilterBar(onChange, {
        defaultRange: '24h',
        referenceEnd: '2026-09-04T12:00:00Z'
      });
      document.body.append(filterBar);
      await Promise.resolve();

      const select = /** @type {HTMLSelectElement} */ (filterBar.querySelector('[aria-label="Time window"]'));
      select.value = '6h';
      select.dispatchEvent(new Event('change'));
      const filterInput = /** @type {HTMLInputElement} */ (filterBar.querySelector('[aria-label="Current filters"]'));
      filterInput.value = 'repository:gh-aw-cao';
      filterInput.dispatchEvent(new Event('input'));

      await vi.waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          new Map([
            ['repository', ['gh-aw-cao']],
            ['mode', ['review', 'live', 'unknown']]
          ]),
          {
            range: '6h',
            start: '2026-09-04T06:00:00.000Z',
            end: '2026-09-04T12:00:00.000Z'
          }
        );
      });
    } finally {
      if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
    }
  });

  it('toggles tuning controls from the horizon text', () => {
    const filterBar = renderFilterBar(vi.fn(), { defaultRange: '24h' });
    const toggle = document.createElement('button');
    toggle.className = 'horizon-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Horizon 1 day';
    filterBar.prepend(toggle);
    document.body.append(filterBar);

    expect(toggle.textContent).toContain('Horizon');
    expect(filterBar.querySelector('.count-badge')?.textContent).toBe('3');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(filterBar.classList.contains('filter-bar-expanded')).toBe(false);

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(filterBar.classList.contains('filter-bar-expanded')).toBe(true);

    filterBar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(filterBar.classList.contains('filter-bar-expanded')).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('closes the horizon controls when clicking outside the filter bar', () => {
    const filterBar = renderFilterBar(vi.fn(), { defaultRange: '24h' });
    const toggle = document.createElement('button');
    toggle.className = 'horizon-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    filterBar.prepend(toggle);
    const dashboard = document.createElement('main');
    dashboard.append(filterBar, document.createElement('button'));
    document.body.append(dashboard);
    enableHorizonOutsideClickDismissal(dashboard);

    toggle.click();
    filterBar.querySelector('[aria-label="Current filters"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    dashboard.lastElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(filterBar.classList.contains('filter-bar-expanded')).toBe(false);
  });

  it('reports no active time filter by default', () => {
    expect(isTimeWindowFilterActive()).toBe(false);
  });

  it('reports an active time filter once a narrower range is persisted', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange, { defaultRange: '24h' });
    document.body.append(filterBar);
    await Promise.resolve();

    const select = /** @type {HTMLSelectElement} */ (filterBar.querySelector('[aria-label="Time window"]'));
    select.value = '6h';
    select.dispatchEvent(new Event('change'));

    expect(isTimeWindowFilterActive('24h')).toBe(true);
  });

  it('is a no-op when clearing a time filter that is already "All time"', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange);
    document.body.append(filterBar);
    await Promise.resolve();

    clearTimeWindowFilter(document);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears an active time filter and re-applies the change through the rendered control', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange, {
      defaultRange: '24h',
      referenceEnd: '2026-09-04T12:00:00Z'
    });
    document.body.append(filterBar);
    await Promise.resolve();

    const select = /** @type {HTMLSelectElement} */ (filterBar.querySelector('[aria-label="Time window"]'));
    select.value = '6h';
    select.dispatchEvent(new Event('change'));
    expect(isTimeWindowFilterActive('24h')).toBe(true);
    onChange.mockClear();

    clearTimeWindowFilter(document);

    expect(select.value).toBe('all');
    expect(onChange).toHaveBeenLastCalledWith(new Map([['mode', ['review', 'live', 'unknown']]]), undefined);
    expect(isTimeWindowFilterActive('24h')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(HORIZON_FILTER_STORAGE_KEY) ?? '{}')).toMatchObject({ range: 'all' });
  });

  it('sets a custom time window through the rendered control', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange);
    document.body.append(filterBar);
    await Promise.resolve();

    setTimeWindowFilter('2026-09-09T00:00:00.000Z', '2026-09-10T00:00:00.000Z', document);

    expect(/** @type {HTMLSelectElement} */ (
      filterBar.querySelector('[aria-label="Time window"]')
    ).value).toBe('custom');
    expect(onChange).toHaveBeenLastCalledWith(new Map([['mode', ['review', 'live', 'unknown']]]), {
      range: 'custom',
      start: '2026-09-09T00:00:00.000Z',
      end: '2026-09-10T00:00:00.000Z'
    });
    expect(JSON.parse(window.localStorage.getItem(HORIZON_FILTER_STORAGE_KEY) ?? '{}')).toMatchObject({
      range: 'custom',
      start: '2026-09-09T00:00:00.000Z',
      end: '2026-09-10T00:00:00.000Z'
    });
  });

  it('restores a preset time window through the rendered control', async () => {
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange, { referenceEnd: '2026-09-11T12:00:00Z' });
    document.body.append(filterBar);
    await Promise.resolve();

    setTimeWindowRange('1w', document);

    expect(/** @type {HTMLSelectElement} */ (
      filterBar.querySelector('[aria-label="Time window"]')
    ).value).toBe('1w');
    expect(onChange).toHaveBeenLastCalledWith(new Map([['mode', ['review', 'live', 'unknown']]]), {
      range: '1w',
      start: '2026-09-04T12:00:00.000Z',
      end: '2026-09-11T12:00:00.000Z'
    });
  });

  it('shares persisted horizon and mode settings across filter bars', async () => {
    const firstChange = vi.fn();
    const first = renderFilterBar(firstChange, {
      defaultRange: '24h',
      referenceEnd: '2026-09-04T12:00:00Z'
    });
    document.body.append(first);
    await Promise.resolve();

    const modes = [...first.querySelectorAll('.mode-filter-control input')];
    /** @type {HTMLInputElement} */ (modes[1]).click();
    const select = /** @type {HTMLSelectElement} */ (first.querySelector('[aria-label="Time window"]'));
    select.value = '6h';
    select.dispatchEvent(new Event('change'));
    const filterInput = /** @type {HTMLInputElement} */ (first.querySelector('[aria-label="Current filters"]'));
    filterInput.value = 'repository:gh-aw-cao';
    filterInput.dispatchEvent(new Event('input'));

    const secondChange = vi.fn();
    const second = renderFilterBar(secondChange, {
      defaultRange: '1w',
      referenceEnd: '2026-09-04T12:00:00Z'
    });
    document.body.append(second);
    await Promise.resolve();

    expect(/** @type {HTMLSelectElement | null} */ (
      second.querySelector('[aria-label="Time window"]')
    )?.value).toBe('6h');
    expect(/** @type {HTMLInputElement | null} */ (
      second.querySelector('[aria-label="Current filters"]')
    )?.value).toBe('repository:gh-aw-cao');
    expect([...second.querySelectorAll('.mode-filter-control input')].map(
      (input) => /** @type {HTMLInputElement} */ (input).checked
    )).toEqual([true, false, true]);
    expect(secondChange).toHaveBeenLastCalledWith(
      new Map([
        ['repository', ['gh-aw-cao']],
        ['mode', ['review', 'unknown']]
      ]),
      {
        range: '6h',
        start: '2026-09-04T06:00:00.000Z',
        end: '2026-09-04T12:00:00.000Z'
      }
    );

    for (const input of second.querySelectorAll('.mode-filter-control input')) {
      const checkbox = /** @type {HTMLInputElement} */ (input);
      if (checkbox.checked) checkbox.click();
    }
    expect(secondChange.mock.calls.at(-1)?.[0]).toEqual(new Map([
      ['repository', ['gh-aw-cao']],
      ['mode', []]
    ]));
    expect(JSON.parse(window.localStorage.getItem(HORIZON_FILTER_STORAGE_KEY) ?? '{}').modes).toEqual([]);
  });

  it('falls back to default modes when persisted modes array contains only invalid entries', async () => {
    window.localStorage.setItem(
      HORIZON_FILTER_STORAGE_KEY,
      JSON.stringify({ range: '24h', modes: ['corrupted_mode', 'invalid'] })
    );
    const onChange = vi.fn();
    const filterBar = renderFilterBar(onChange, {
      defaultRange: '24h',
      referenceEnd: '2026-09-04T12:00:00Z'
    });
    document.body.append(filterBar);
    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
  });
});