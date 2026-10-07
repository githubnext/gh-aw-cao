// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('worker query progress', () => {
  it('publishes start and completion for a paginated query and its continuation', async () => {
    /** @type {Array<{ type?: string, state?: { id: string, phase: string } }>} */
    const messages = [];
    vi.stubGlobal('self', { addEventListener: vi.fn(), postMessage: (/** @type {typeof messages[number]} */ message) => messages.push(message) });
    const { processDataRequest } = await import('../../src/data-worker.js');
    const request = {
      operation: 'execute-dashboard-queries',
      queries: [{ name: 'list', from: 'runs' }],
      sourceNames: ['list'],
      sources: { runs: { source: 'runs', rows: [{ run: '1' }, { run: '2' }] } },
      pagination: { list: { limit: 1 } }
    };
    const first = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest(request));
    const next = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      ...request, pagination: { list: { limit: 1, continuationToken: first.list.continuationToken } }
    }));
    expect(next.list.rows).toEqual([{ run: '2' }]);
    expect(messages.map((message) => message.state?.phase)).toEqual(['start', 'complete', 'start', 'complete']);
    expect(messages[0].state?.id).toBe(messages[1].state?.id);
    expect(messages[2].state?.id).toBe(messages[3].state?.id);
    expect(messages[0].state?.id).not.toBe(messages[2].state?.id);
  });

  it('clears query progress on stale-token failures and cancellation without swallowing the error', async () => {
    /** @type {Array<{ state?: { id: string, phase: string } }>} */
    const messages = [];
    vi.stubGlobal('self', { addEventListener: vi.fn(), postMessage: (/** @type {typeof messages[number]} */ message) => messages.push(message) });
    const { processDataRequest } = await import('../../src/data-worker.js');
    const request = {
      operation: 'execute-dashboard-queries',
      queries: [{ name: 'list', from: 'runs' }], sourceNames: ['list'],
      sources: { runs: { source: 'runs', rows: [{ run: '1' }] } },
      pagination: { list: { limit: 1, continuationToken: 'stale' } }
    };
    expect(() => processDataRequest(request)).toThrow(/stale/);
    expect(messages.map((message) => message.state?.phase)).toEqual(['start', 'complete']);
    messages.length = 0;
    const controller = new AbortController();
    controller.abort();
    expect(() => processDataRequest({ ...request, pagination: {} }, controller.signal)).toThrow(/cancelled/);
    expect(messages.map((message) => message.state?.phase)).toEqual(['start', 'complete']);
  });

  it('keeps progress active for asynchronous canonical queries and clears it on failure', async () => {
    /** @type {Array<{ state?: { id: string, phase: string } }>} */
    const messages = [];
    vi.stubGlobal('self', { addEventListener: vi.fn(), postMessage: (/** @type {typeof messages[number]} */ message) => messages.push(message) });
    const { processDataRequest } = await import('../../src/data-worker.js');
    const response = processDataRequest({
      operation: 'query-canonical-dashboard', sourceNames: ['runs'],
      context: { pages: [], queries: [] },
      pagination: { runs: { limit: 0 } }
    });
    expect(messages.map((message) => message.state?.phase)).toEqual(['start']);
    await expect(response).rejects.toThrow(/positive integer/);
    expect(messages.map((message) => message.state?.phase)).toEqual(['start', 'complete']);
  });
});
