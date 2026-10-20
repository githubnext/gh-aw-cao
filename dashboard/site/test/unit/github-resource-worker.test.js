// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { deleteCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('wires resource subscriptions through the existing worker message listener with shared requests and cleanup', async () => {
  await deleteCanonicalDatabase(indexedDB);
  /** @type {((event: { data: Record<string, unknown> }) => void) | undefined} */
  let onMessage;
  const postMessage = vi.fn();
  vi.stubGlobal('self', {
    addEventListener: (/** @type {string} */ _type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => { onMessage = listener; },
    postMessage
  });
  /** @type {AbortSignal | undefined} */
  let requestSignal;
  /** @type {(response: Response) => void} */
  let release = () => {};
  const fetch = vi.fn((_url, init) => {
    requestSignal = init.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  vi.stubGlobal('fetch', fetch);
  await import('../../src/data-worker.js');
  const request = {
    operation: 'subscribe-github-resource', resource: { owner: 'githubnext', repo: 'gh-cao' },
    configuration: { baseUrl: 'https://dashboard.example/api/v1/github/' }
  };
  onMessage?.({ data: { ...request, subscriptionId: 'one' } });
  onMessage?.({ data: { ...request, subscriptionId: 'two' } });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  onMessage?.({ data: { operation: 'unsubscribe-github-resource', subscriptionId: 'one' } });
  expect(requestSignal?.aborted).toBe(false);
  release(Response.json({ full_name: 'githubnext/gh-cao' }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'github-resource', subscriptionId: 'two', snapshot: expect.objectContaining({ source: 'network' })
  })));
  expect(postMessage.mock.calls.some(([message]) => message.subscriptionId === 'one' && message.snapshot.source === 'network')).toBe(false);
  onMessage?.({ data: { operation: 'unsubscribe-github-resource', subscriptionId: 'two' } });
});
