import { ReadableStream as NodeReadableStream } from 'node:stream/web';

if (typeof globalThis.ReadableStream === 'undefined') {
  Object.defineProperty(globalThis, 'ReadableStream', { configurable: true, value: NodeReadableStream });
}

function createMemoryStorage() {
  const entries = new Map();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    /** @param {string} key */
    getItem(key) {
      return entries.has(String(key)) ? entries.get(String(key)) : null;
    },
    /** @param {number} index */
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    /** @param {string} key */
    removeItem(key) {
      entries.delete(String(key));
    },
    /** @param {string} key @param {string} value */
    setItem(key, value) {
      entries.set(String(key), String(value));
    }
  };
}

if (typeof window !== 'undefined' && typeof window.localStorage?.getItem !== 'function') {
  const localStorage = createMemoryStorage();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
}

/**
 * Minimal exclusive Web Locks manager for environments without the real API.
 * Browsers serialize canonical dashboard ingestion through `navigator.locks`,
 * so tests need the same behaviour to cover the production code path. Waiters
 * are granted the lock in request order, like the Web Locks API grants them.
 */
function createLockManager() {
  /** @type {Map<string, (() => void)[]>} */
  const queues = new Map();
  return {
    /**
     * @param {string} name
     * @param {{ signal?: AbortSignal } | ((lock: { name: string }) => unknown)} optionsOrCallback
     * @param {(lock: { name: string }) => unknown} [maybeCallback]
     */
    async request(name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback ?? {};
      if (typeof callback !== 'function') throw new TypeError('A lock request requires a callback.');
      const waiters = queues.get(name) ?? [];
      queues.set(name, waiters);
      /** @type {() => void} */
      let grant = () => {};
      const granted = new Promise((resolve) => { grant = () => resolve(undefined); });
      waiters.push(grant);
      if (waiters.length === 1) grant();
      /** @type {() => void} */
      let stopWatchingAbort = () => {};
      try {
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException('The lock request was aborted.', 'AbortError'));
          if (options.signal?.aborted) {
            abort();
            return;
          }
          options.signal?.addEventListener('abort', abort);
          stopWatchingAbort = () => options.signal?.removeEventListener('abort', abort);
          void granted.then(resolve);
        });
      } catch (error) {
        stopWatchingAbort();
        const pending = waiters.indexOf(grant);
        if (pending >= 0) {
          waiters.splice(pending, 1);
          if (pending === 0) waiters[0]?.();
        }
        if (waiters.length === 0) queues.delete(name);
        throw error;
      }
      stopWatchingAbort();
      try {
        return await callback({ name });
      } finally {
        waiters.shift();
        waiters[0]?.();
        if (waiters.length === 0) queues.delete(name);
      }
    }
  };
}

if (typeof navigator !== 'undefined' && typeof navigator.locks?.request !== 'function') {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createLockManager() });
}
