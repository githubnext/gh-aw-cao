import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
  vi.resetModules();
  window.history.replaceState(null, '', `/${search}`);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const module = await import('../../src/components/route-body-composition.js');
  return { debug, selectConfigBody: module.selectConfigBody };
}

describe('route body composition debug logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  const config = { values: ['reports', 'runs'], fallback: 'reports' };

  it('is silent by default and preserves selection', async () => {
    const { debug, selectConfigBody } = await load('');
    expect(selectConfigBody(config, 'runs')).toBe('runs');
    expect(selectConfigBody(config, 'bad')).toBe('reports');
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs fallbacks under the filename category without the rejected value', async () => {
    const { debug, selectConfigBody } = await load('?debug=route-body-composition');
    expect(selectConfigBody(config, 'runs')).toBe('runs');
    expect(debug).not.toHaveBeenCalled();
    expect(selectConfigBody(config, 'secret-token')).toBe('reports');
    expect(debug).toHaveBeenCalledWith('[cao:route-body-composition]', {
      event: 'body-fallback', selectedType: 'string', fallback: 'reports', allowedCount: 2
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-token');
  });

  it('respects other categories and exclusions', async () => {
    const other = await load('?debug=data');
    other.selectConfigBody(config, null);
    expect(other.debug).not.toHaveBeenCalled();
    const excluded = await load('?debug=*,-route-body-composition');
    excluded.selectConfigBody(config, null);
    expect(excluded.debug).not.toHaveBeenCalled();
  });
});
