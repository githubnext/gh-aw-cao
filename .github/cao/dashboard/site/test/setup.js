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