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
 * so tests need the same behaviour to cover the production code path.
 */
function createLockManager() {
  /** @type {Map<string, Promise<unknown>>} */
  const held = new Map();
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
      while (held.has(name)) {
        await Promise.race([
          held.get(name),
          new Promise((_, reject) => {
            if (!options.signal) return;
            if (options.signal.aborted) reject(new DOMException('The lock request was aborted.', 'AbortError'));
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('The lock request was aborted.', 'AbortError')),
              { once: true }
            );
          })
        ]);
      }
      /** @type {() => void} */
      let release = () => {};
      held.set(name, new Promise((resolve) => { release = () => resolve(undefined); }));
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        release();
      }
    }
  };
}

if (typeof navigator !== 'undefined' && typeof navigator.locks?.request !== 'function') {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createLockManager() });
}
