import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDashboardHorizon } from '../../src/components/dashboard-horizon.js';

/** @returns {import('../../src/presenter.js').PresentableDashboard} */
function makeDashboard() {
  return /** @type {any} */ ({
    horizon: { label: 'Horizon', tooltip: { label: 'Horizon', description: 'Evidence coverage.' } }
  });
}

describe('dashboard horizon', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('renders a skeleton while unavailable and resolves once available', () => {
    const horizon = renderDashboardHorizon({
      dashboard: makeDashboard(),
      initialValue: { available: false, evaluatedAt: '', duration: '', start: '', end: '' },
      formatDate: (value) => value
    });
    document.body.append(horizon.element);

    expect(horizon.element.getAttribute('aria-label')).toBe('Horizon unavailable');

    horizon.update({ available: true, evaluatedAt: '2024-01-02T00:00:00Z', duration: '3 days', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' });

    expect(horizon.element.hasAttribute('aria-label')).toBe(false);
    expect(horizon.element.dataset.dashboardEvaluatedAt).toBe('2024-01-02T00:00:00Z');

    horizon.dispose();
  });

  it('stays silent by default and logs only scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=dashboard-horizon', output })
      };
    });
    vi.resetModules();
    const { renderDashboardHorizon: renderDashboardHorizonWithDebug } = await import('../../src/components/dashboard-horizon.js');

    const horizon = renderDashboardHorizonWithDebug({
      dashboard: makeDashboard(),
      initialValue: { available: false, evaluatedAt: '', duration: '', start: '', end: '' },
      formatDate: (value) => value
    });
    document.body.append(horizon.element);

    horizon.update({ available: true, evaluatedAt: '2024-01-02T00:00:00Z', duration: '3 days', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' });
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-horizon]', { event: 'resolved', duration: '3 days' });

    /** @type {HTMLButtonElement} */ (horizon.element.querySelector('.horizon-toggle')).click();
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-horizon]', { event: 'toggled', expanded: true });

    horizon.dispose();
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-horizon]', { event: 'disposed' });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { renderDashboardHorizon: renderDashboardHorizonWithoutDebug } = await import('../../src/components/dashboard-horizon.js');

    const horizon = renderDashboardHorizonWithoutDebug({
      dashboard: makeDashboard(),
      initialValue: { available: false, evaluatedAt: '', duration: '', start: '', end: '' },
      formatDate: (value) => value
    });
    document.body.append(horizon.element);

    horizon.update({ available: true, evaluatedAt: '2024-01-02T00:00:00Z', duration: '3 days', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' });
    /** @type {HTMLButtonElement} */ (horizon.element.querySelector('.horizon-toggle')).click();
    horizon.dispose();

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
