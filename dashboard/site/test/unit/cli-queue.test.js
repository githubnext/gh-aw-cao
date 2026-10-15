import { afterEach, describe, expect, it, vi } from 'vitest';
import commands from '../../dashboard-fragments/commands.json' with { type: 'json' };
import { cliQueueOperation, configureCliQueue, queryCliQueue } from '../../src/data/cli-queue.js';
import { processDataRequest } from '../../src/data-worker.js';
import { cliQueueAvailable, enqueueCliCommand } from '../../src/data-processor.js';

afterEach(() => {
  configureCliQueue(false);
  vi.unstubAllGlobals();
});

describe('worker command queue', () => {
  it('fails closed without advertised local authority and never fetches', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(cliQueueAvailable()).toBe(false);
    await expect(enqueueCliCommand({ id: 'compile' })).rejects.toThrow('unavailable');
    await expect(cliQueueOperation({ action: 'list' })).rejects.toThrow('unavailable');
    const result = await queryCliQueue({
      sourceNames: ['command-queue'], context: { pages: [], queries: commands.queries }
    });
    expect(result['command-queue'].metadata.availability).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs real declared queries over server pages with authoritative counts', async () => {
    configureCliQueue(true);
    const states = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused'];
    const fetch = vi.fn().mockResolvedValue(Response.json({
      commands: states.map((status, index) => ({ id: `cmd-${index}`, actionId: 'compile', status })),
      total: 106, running: 8, revision: 20, pausedReason: 'quota'
    }));
    vi.stubGlobal('fetch', fetch);
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
      operation: 'query-canonical-dashboard',
      sourceNames: ['command-queue', 'command-queue-summary'],
      context: { pages: [], queries: commands.queries },
      pagination: { 'command-queue': { limit: 6 } },
      queryContext: { filters: { status: ['queued', 'running'] } }
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('status=queued%2Crunning&limit=6&offset=0');
    expect(result['command-queue'].rows.map((row) => row.status)).toEqual(states);
    expect(result['command-queue'].rows[0]['command-link']).toEqual(expect.objectContaining({ 'dashboard-href': '#page-command?command=cmd-0' }));
    expect(result['command-queue-summary'].rows[0]).toMatchObject({ running: 8, total: 106, 'paused-reason': 'quota' });
    expect(result['command-queue'].metadata['total-row-count']).toBe(106);
    expect(JSON.parse(atob(result['command-queue'].continuationToken ?? ''))).toEqual({ offset: 6 });
  });

  it('sends continuation offset to the server rather than loading the queue into the browser', async () => {
    configureCliQueue(true);
    const fetch = vi.fn().mockResolvedValue(Response.json({ commands: [], total: 30, running: 0, revision: 1 }));
    vi.stubGlobal('fetch', fetch);
    await queryCliQueue({
      sourceNames: ['command-queue'], context: { pages: [], queries: commands.queries },
      pagination: { 'command-queue': { limit: 10, continuationToken: btoa(JSON.stringify({ offset: 20 })) } }
    });
    expect(String(fetch.mock.calls[0][0])).toContain('limit=10&offset=20');
  });

  it('enqueues only declared action arguments and returns a durable ID through worker dispatch', async () => {
    configureCliQueue(true);
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'durable-1', status: 'queued' }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const command = { id: 'compile', arguments: {}, values: {}, idempotencyKey: 'approved-once' };
    expect(await processDataRequest({ operation: 'cli-queue', action: 'enqueue', command })).toEqual({ id: 'durable-1', status: 'queued' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(command);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
  });

  it('replays sequenced NDJSON once and keeps cancellation separate from stream detachment', async () => {
    configureCliQueue(true);
    const completion = { type: 'complete', result: { ok: false, exitCode: 1 }, command: { id: 'durable-1', status: 'failed' } };
    const events = [
      { type: 'output', sequence: 1, stream: 'stdout', data: 'old' },
      { type: 'output', sequence: 2, stream: 'stderr', data: 'new\n' },
      { type: 'output', sequence: 2, stream: 'stderr', data: 'duplicate' },
      completion
    ];
    const fetch = vi.fn().mockResolvedValue(new Response(events.map((event) => JSON.stringify(event)).join('\n')));
    vi.stubGlobal('fetch', fetch);
    const notify = vi.fn();
    expect(await cliQueueOperation({ action: 'attach', commandId: 'durable-1', after: 1 }, undefined, notify)).toEqual(completion);
    expect(notify).toHaveBeenCalledExactlyOnceWith(events[1]);
    expect(String(fetch.mock.calls[0][0])).toContain('/durable-1/output?after=1');
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });

  it('routes explicit cancel and retry to separate POST endpoints', async () => {
    configureCliQueue(true);
    const fetch = vi.fn().mockImplementation(async () => Response.json({ id: 'durable-1' }));
    vi.stubGlobal('fetch', fetch);
    await cliQueueOperation({ action: 'cancel', commandId: 'durable-1' });
    await cliQueueOperation({ action: 'retry', commandId: 'durable-1', idempotencyKey: 'retry-once' });
    expect(String(fetch.mock.calls[0][0])).toContain('/durable-1/cancel');
    expect(String(fetch.mock.calls[1][0])).toContain('/durable-1/retry');
    expect(fetch.mock.calls.every(([, options]) => options.method === 'POST')).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ idempotencyKey: 'retry-once' });
  });
});
