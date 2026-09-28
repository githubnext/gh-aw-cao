import { processDataRequest } from '../src/data-worker.js';

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
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: { id: request.id, data: processDataRequest(request) }
    })));
  }

  terminate() {}
}
