// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  document.head.innerHTML = '';
});

/** @param {string} search */
async function loadStorageInfo(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/components/storage-info.js');
  return { ...module, output };
}

/** @param {string} content */
function declareBackend(content) {
  document.head.innerHTML = `<meta name="dashboard-storage-backend" content="${content}">`;
}

const context = /** @type {any} */ ({ title: 'Storage' });

describe('storage-info debug logging', () => {
  it('is silent by default', async () => {
    declareBackend('sqlite');
    const { renderStorageInfo, output } = await loadStorageInfo('');
    renderStorageInfo(context);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the resolved backend under the filename-derived category', async () => {
    declareBackend('sqlite');
    const { renderStorageInfo, output } = await loadStorageInfo('?debug=storage-info');
    renderStorageInfo(context);
    expect(output.debug).toHaveBeenCalledWith('[cao:storage-info]', {
      event: 'backend-resolved', backend: 'sqlite', declared: true
    });
  });

  it('does not log declared values that are not recognized', async () => {
    declareBackend('secret-token-value');
    const { renderStorageInfo, output } = await loadStorageInfo('?debug=storage-info');
    renderStorageInfo(context);
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('secret-token-value');
    expect(output.debug.mock.calls[0][1]).toEqual({ event: 'backend-resolved', backend: 'unrecognized', declared: true });
  });

  it('respects category exclusion', async () => {
    declareBackend('postgres');
    const { renderStorageInfo, output } = await loadStorageInfo('?debug=*,-storage-info');
    renderStorageInfo(context);
    expect(output.debug).not.toHaveBeenCalled();
  });
});
