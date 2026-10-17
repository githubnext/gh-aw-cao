import { afterEach, describe, expect, it, vi } from 'vitest';

/** @type {{ outcome: () => Promise<unknown> }} */
const processor = { outcome: async () => [] };
vi.mock('../../src/data-processor.js', () => ({ processDashboardCallouts: () => processor.outcome() }));

const callouts = [{ id: 'secret-callout-id', title: 'Private title', description: 'Private text', 'visible-when': { source: 'freshness', field: 'at' } }];
const sources = { freshness: { rows: [{ at: 'private-row-value' }] } };

/** @param {string} search */
async function subscribe(search) {
  vi.resetModules();
  window.history.replaceState(null, '', `/${search}`);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const { subscribeCalloutVisibility } = await import('../../src/data/callouts.js');
  const onUpdate = vi.fn();
  const onError = vi.fn(() => {});
  const controller = new AbortController();
  subscribeCalloutVisibility(/** @type {any} */ (callouts), /** @type {any} */ (sources), undefined, controller.signal, onUpdate, onError);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  controller.abort();
  return { debug, onUpdate, onError };
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('callout subscription debug logging', () => {
  it('is silent by default', async () => {
    processor.outcome = async () => [];
    const { debug, onUpdate } = await subscribe('');
    expect(onUpdate).toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs evaluation counts under data:callouts', async () => {
    processor.outcome = async () => [{ id: 'a' }, { id: 'b' }];
    const { debug } = await subscribe('?debug=data:callouts');
    expect(debug).toHaveBeenCalledWith('[cao:data:callouts]', { event: 'evaluated', status: 'ok', calloutCount: 2 });
  });

  it('logs only the sanitized error name and no row or callout content', async () => {
    const error = new RangeError('private-row-value failure');
    processor.outcome = async () => { throw error; };
    const { debug, onError } = await subscribe('?debug=data:*');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('[cao:data:callouts]', { event: 'evaluation-failed', errorName: 'RangeError' });
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/private|secret/);
  });

  it('is not enabled by other categories', async () => {
    processor.outcome = async () => [];
    const { debug } = await subscribe('?debug=render:*');
    expect(debug).not.toHaveBeenCalled();
  });
});
