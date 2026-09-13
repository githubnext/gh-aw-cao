import { describe, expect, it, vi } from 'vitest';
import { createDebug, isDebugEnabled } from '../../src/debug.js';

describe('dashboard debug logging', () => {
  it('is disabled without the debug query parameter', () => {
    expect(isDebugEnabled('data', '?mode=live')).toBe(false);
    expect(isDebugEnabled('data', '?debug=')).toBe(false);
  });

  it('supports exact, wildcard, and excluded categories', () => {
    expect(isDebugEnabled('data', '?debug=data,render')).toBe(true);
    expect(isDebugEnabled('render:lazy', '?debug=render:*')).toBe(true);
    expect(isDebugEnabled('render:verbose', '?debug=render:*,-render:verbose')).toBe(false);
    expect(isDebugEnabled('worker', '?debug=1')).toBe(true);
    expect(isDebugEnabled('worker', '?debug=true')).toBe(true);
    expect(isDebugEnabled('other', '?debug=data,render')).toBe(false);
  });

  it('checks the query once when created and prefixes matching output', () => {
    let search = '?debug=data';
    const output = { debug: vi.fn() };
    const debug = createDebug('data', { search: () => search, output });

    debug('loaded', { count: 3 });
    search = '?debug=render';
    debug('still enabled');

    expect(output.debug).toHaveBeenCalledTimes(2);
    expect(output.debug).toHaveBeenCalledWith('[cao:data]', 'loaded', { count: 3 });
    expect(output.debug).toHaveBeenCalledWith('[cao:data]', 'still enabled');
  });

  it('keeps a logger disabled when the query changes later', () => {
    let search = '?debug=render';
    const output = { debug: vi.fn() };
    const debug = createDebug('data', { search: () => search, output });

    search = '?debug=data';
    debug('ignored');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('reuses one no-op function for disabled categories', () => {
    const search = () => '?debug=render';

    expect(createDebug('data', { search })).toBe(createDebug('worker', { search }));
  });
});
