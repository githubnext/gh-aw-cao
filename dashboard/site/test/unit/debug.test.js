import { describe, expect, it, vi } from 'vitest';
import {
  createDebug,
  debugEagerIngest,
  debugShardLimit,
  fullDebugUrl,
  isDebugEnabled,
  withDebugParameter
} from '../../src/debug.js';

describe('dashboard debug logging', () => {
  it('builds a full-debug reload URL without losing the current route', () => {
    expect(fullDebugUrl('https://example.test/dashboard?local-preview=1#page-settings'))
      .toBe('https://example.test/dashboard?local-preview=1&debug=1#page-settings');
  });

  it('is disabled without the debug query parameter', () => {
    expect(isDebugEnabled('data', '?mode=live')).toBe(false);
    expect(isDebugEnabled('data', '?debug=')).toBe(false);
  });

  it('supports exact, wildcard, and excluded categories', () => {
    expect(isDebugEnabled('data', '?debug=data,render')).toBe(true);
    expect(isDebugEnabled('auth', '?debug=auth')).toBe(true);
    expect(isDebugEnabled('render:lazy', '?debug=render:*')).toBe(true);
    expect(isDebugEnabled('render:verbose', '?debug=render:*,-render:verbose')).toBe(false);
    expect(isDebugEnabled('worker', '?debug=1')).toBe(true);
    expect(isDebugEnabled('worker', '?debug=true')).toBe(true);
    expect(isDebugEnabled('other', '?debug=data,render')).toBe(false);
  });

  it('forwards the debug parameter onto a worker or service worker script URL', () => {
    const url = withDebugParameter(new URL('https://example.test/data-worker.js'), '?debug=data:*&debug-shard-limit=10&mode=live');
    expect(url.href).toBe('https://example.test/data-worker.js?debug=data%3A*&debug-shard-limit=10');
  });

  it('leaves a worker script URL untouched when debug is not set', () => {
    const url = withDebugParameter(new URL('https://example.test/data-worker.js'), '?mode=live');
    expect(url.href).toBe('https://example.test/data-worker.js');
  });

  it('accepts only positive safe integer debug shard limits', () => {
    expect(debugShardLimit('?debug-shard-limit=10')).toBe(10);
    expect(debugShardLimit('?debug-shard-limit=0')).toBeUndefined();
    expect(debugShardLimit('?debug-shard-limit=1.5')).toBeUndefined();
    expect(debugShardLimit('?debug-shard-limit=9007199254740992')).toBeUndefined();
  });

  it('forces eager ingestion unless the parameter is absent or disabled', () => {
    expect(debugEagerIngest('?debug-eager-ingest=1')).toBe(true);
    expect(debugEagerIngest('?debug-eager-ingest')).toBe(true);
    expect(debugEagerIngest('?debug-eager-ingest=0')).toBe(false);
    expect(debugEagerIngest('?debug-eager-ingest=FALSE')).toBe(false);
    expect(debugEagerIngest('?mode=live')).toBe(false);
  });

  it('forwards the eager ingestion parameter onto the worker script URL', () => {
    const url = withDebugParameter(new URL('https://example.test/data-worker.js'), '?debug-eager-ingest=1');
    expect(url.href).toBe('https://example.test/data-worker.js?debug-eager-ingest=1');
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
