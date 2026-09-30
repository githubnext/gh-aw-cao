import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('dashboard theme settings reactive state', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('applies the selected theme to the dashboard root and syncs every button aria-pressed', async () => {
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');
    const dashboardRoot = Object.assign(document.createElement('div'), { className: 'dashboard-root' });
    document.body.replaceChildren(dashboardRoot);
    const control = renderThemeControl();
    dashboardRoot.appendChild(control);

    expect(dashboardRoot.dataset.theme).toBeUndefined();
    expect(control.querySelector('[data-theme-value="system"]')?.getAttribute('aria-pressed')).toBe('true');

    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="dark"]')).click();

    expect(dashboardRoot.dataset.theme).toBe('dark');
    expect(control.querySelector('[data-theme-value="dark"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(control.querySelector('[data-theme-value="system"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(control.querySelector('[data-theme-value="light"]')?.getAttribute('aria-pressed')).toBe('false');

    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="light"]')).click();

    expect(dashboardRoot.dataset.theme).toBe('light');
    expect(control.querySelector('[data-theme-value="light"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(control.querySelector('[data-theme-value="dark"]')?.getAttribute('aria-pressed')).toBe('false');
    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="system"]')).click();
    expect(dashboardRoot.dataset.theme).toBeUndefined();
    expect(control.querySelector('[data-theme-value="system"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('restores the saved preference when the Settings control is opened', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    const { renderThemeControl, restoreDashboardTheme } = await import('../../src/components/theme-settings.js');
    const dashboardRoot = Object.assign(document.createElement('div'), { className: 'dashboard-root' });
    document.body.replaceChildren(dashboardRoot);
    restoreDashboardTheme(dashboardRoot);
    const control = renderThemeControl();
    dashboardRoot.append(control);

    expect(dashboardRoot.dataset.theme).toBe('dark');
    expect(control.querySelector('[data-theme-value="dark"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('retains the in-session selection across Settings navigation when storage rejects writes', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'light');
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');
    const dashboardRoot = Object.assign(document.createElement('div'), { className: 'dashboard-root' });
    document.body.replaceChildren(dashboardRoot);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    try {
      const control = renderThemeControl();
      dashboardRoot.append(control);
      /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="dark"]')).click();
      expect(dashboardRoot.dataset.theme).toBe('dark');

      control.remove();
      const reopened = renderThemeControl();
      dashboardRoot.append(reopened);
      expect(reopened.querySelector('[data-theme-value="dark"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(dashboardRoot.dataset.theme).toBe('dark');
      expect(localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('light');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('stops reacting to theme changes once the control detaches from the document', async () => {
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');
    const dashboardRoot = Object.assign(document.createElement('div'), { className: 'dashboard-root' });
    document.body.replaceChildren(dashboardRoot);
    const control = renderThemeControl();
    dashboardRoot.appendChild(control);

    control.remove();
    // Let the MutationObserver microtask backing createFactoryScope run.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    dashboardRoot.appendChild(control);
    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="dark"]')).click();

    // The effect stopped when the control detached, so re-attaching and
    // clicking no longer updates a root that is no longer reachable via the
    // stopped effect's closure-captured button list.
    expect(control.querySelector('[data-theme-value="dark"]')?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('dashboard theme settings debug logging', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.doUnmock('../../src/debug.js');
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
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');

    renderThemeControl();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs restore with a predictable category and scalar metadata only', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=theme-settings', output })
      };
    });
    vi.resetModules();
    localStorage.setItem('central-agentic-ops.dashboard.theme', 'dark');
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');

    renderThemeControl();

    expect(output.debug).toHaveBeenCalledWith('[cao:theme-settings]', { event: 'restored', theme: 'dark', fallback: false });
    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('logs a fallback restore when no stored theme is present', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=theme-settings', output })
      };
    });
    vi.resetModules();
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');

    renderThemeControl();

    expect(output.debug).toHaveBeenCalledWith('[cao:theme-settings]', { event: 'restored', theme: 'system', fallback: true });
  });

  it('logs a persisted theme change without leaking sensitive values', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=theme-settings', output })
      };
    });
    vi.resetModules();
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');
    document.body.replaceChildren(/** @type {Node} */ (Object.assign(document.createElement('div'), { className: 'dashboard-root' })));
    const control = renderThemeControl();
    document.body.firstElementChild?.appendChild(control);

    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="dark"]')).click();

    expect(output.debug).toHaveBeenCalledWith('[cao:theme-settings]', { event: 'changed', theme: 'dark', persisted: true });
    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('logs a persistence failure with only a sanitized error name', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=theme-settings', output })
      };
    });
    vi.resetModules();
    const { renderThemeControl } = await import('../../src/components/theme-settings.js');
    document.body.replaceChildren(/** @type {Node} */ (Object.assign(document.createElement('div'), { className: 'dashboard-root' })));
    const control = renderThemeControl();
    document.body.firstElementChild?.appendChild(control);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    /** @type {HTMLButtonElement} */ (control.querySelector('[data-theme-value="light"]')).click();

    expect(output.debug).toHaveBeenCalledWith('[cao:theme-settings]', {
      event: 'changed',
      theme: 'light',
      persisted: false,
      errorName: 'QuotaExceededError'
    });
    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    setItemSpy.mockRestore();
  });
});
