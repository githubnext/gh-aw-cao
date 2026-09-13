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

  it('reads the current query each time and prefixes matching output', () => {
    let search = '?debug=data';
    const output = { debug: vi.fn() };
    const debug = createDebug('data', { search: () => search, output });

    debug('loaded', { count: 3 });
    search = '?debug=render';
    debug('ignored');

    expect(output.debug).toHaveBeenCalledOnce();
    expect(output.debug).toHaveBeenCalledWith('[cao:data]', 'loaded', { count: 3 });
  });
});
