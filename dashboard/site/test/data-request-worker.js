import { processDataRequest } from '../src/data-worker.js';
import { configureCliQueue } from '../src/data/cli-queue.js';

/**
 * Worker stub that executes the real data-worker request handler.
 *
 * Row operations, table summaries, and scatter clustering run exclusively in
 * the data worker, so tests drive the production path through this stub
 * instead of a main-thread fallback.
 */
export class DataRequestWorker extends EventTarget {
  /** @param {Record<string, unknown>} request */
  postMessage(request) {
    if (request.operation === 'configure-cli-queue') {
      configureCliQueue(request.enabled === true, String(request.endpoint));
      return;
    }
    queueMicrotask(async () => {
      try {
        const data = await processDataRequest(request);
        this.dispatchEvent(new MessageEvent('message', { data: { id: request.id, data } }));
      } catch (error) {
        this.dispatchEvent(new MessageEvent('message', {
          data: { id: request.id, error: error instanceof Error ? error.message : String(error) }
        }));
      }
    });
  }

  terminate() {}
}
