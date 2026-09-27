// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Builds the minimal DOM structure enableDashboardNavigation expects. */
function buildNavigationRoot() {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="app-shell">
      <button class="sidebar-toggle" type="button"></button>
    </div>
    <details class="nav-section" data-nav-section="Data"></details>
  `;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('dashboard navigation debug logging', () => {
  it('stays silent without a matching debug category', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const storageError = new Error('denied');
    storageError.name = 'SecurityError';
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw storageError;
    });

    const { enableDashboardNavigation } = await import('../../src/components/dashboard-navigation.js');
    const root = buildNavigationRoot();
    enableDashboardNavigation(root);

    expect(debug).not.toHaveBeenCalled();
  });

  it('logs a sanitized error name when reading sidebar state fails', async () => {
    window.history.replaceState({}, '', '?debug=dashboard-navigation');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const storageError = new Error('storage disabled in this context');
    storageError.name = 'SecurityError';
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw storageError;
    });

    const { enableDashboardNavigation } = await import('../../src/components/dashboard-navigation.js');
    const root = buildNavigationRoot();
    enableDashboardNavigation(root);

    expect(debug).toHaveBeenCalledWith(
      '[cao:dashboard-navigation]',
      { event: 'sidebar-state.read_failed', errorName: 'SecurityError' }
    );
    expect(debug).not.toHaveBeenCalledWith(
      '[cao:dashboard-navigation]',
      expect.objectContaining({ message: expect.anything() })
    );
  });

  it('logs a sanitized error name when persisting sidebar state fails', async () => {
    window.history.replaceState({}, '', '?debug=dashboard-navigation');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const writeError = new Error('quota exceeded');
    writeError.name = 'QuotaExceededError';
    const fakeStorage = {
      getItem: () => null,
      setItem: () => {
        throw writeError;
      }
    };
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(/** @type {Storage} */ (/** @type {unknown} */ (fakeStorage)));

    const { enableDashboardNavigation } = await import('../../src/components/dashboard-navigation.js');
    const root = buildNavigationRoot();
    enableDashboardNavigation(root);
    const toggle = root.querySelector('.sidebar-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('sidebar toggle was not rendered');
    toggle.click();

    expect(debug).toHaveBeenCalledWith(
      '[cao:dashboard-navigation]',
      { event: 'sidebar-state.write_failed', errorName: 'QuotaExceededError' }
    );
  });

  it('logs a sanitized error name when reading persisted nav-section state fails', async () => {
    window.history.replaceState({}, '', '?debug=dashboard-navigation');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const readError = new Error('storage disabled');
    readError.name = 'SecurityError';
    const fakeStorage = {
      getItem: () => {
        throw readError;
      },
      setItem: () => {}
    };
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(/** @type {Storage} */ (/** @type {unknown} */ (fakeStorage)));

    const { enableDashboardNavigation } = await import('../../src/components/dashboard-navigation.js');
    const root = buildNavigationRoot();
    enableDashboardNavigation(root);

    expect(debug).toHaveBeenCalledWith(
      '[cao:dashboard-navigation]',
      { event: 'nav-section-state.read_failed', errorName: 'SecurityError' }
    );
  });
});
