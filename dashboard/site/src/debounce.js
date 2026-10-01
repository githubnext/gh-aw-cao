import { createDebug } from './debug.js';

const debugDebounce = createDebug('debounce');

/**
 * @template {unknown[]} Args
 * @param {(...args: Args) => void} callback
 * @param {number} delay
 * @returns {((...args: Args) => void) & { cancel: () => void }}
 */
export function debounce(callback, delay) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const clear = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const cancel = () => {
    const hadPending = timer !== undefined;
    clear();
    if (hadPending) debugDebounce({ event: 'cancelled', mode: 'debounce' });
  };
  const debounced = /** @type {((...args: Args) => void) & { cancel: () => void }} */ ((...args) => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      debugDebounce({ event: 'fired', mode: 'debounce', delayMs: delay });
      callback(...args);
    }, delay);
  });
  debounced.cancel = cancel;
  return debounced;
}

/**
 * Runs immediately, then at most once per interval while retaining the latest
 * arguments for the trailing invocation.
 * @template {unknown[]} Args
 * @param {(...args: Args) => void} callback
 * @param {number} delay
 * @returns {((...args: Args) => void) & { cancel: () => void }}
 */
export function throttle(callback, delay) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Args | undefined} */
  let latest;
  let lastRun = 0;
  const cancel = () => {
    const hadPending = timer !== undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    latest = undefined;
    if (hadPending) debugDebounce({ event: 'cancelled', mode: 'throttle' });
  };
  const invoke = () => {
    timer = undefined;
    if (!latest) return;
    const args = latest;
    latest = undefined;
    lastRun = Date.now();
    debugDebounce({ event: 'fired', mode: 'throttle', delayMs: delay });
    callback(...args);
  };
  const throttled = /** @type {((...args: Args) => void) & { cancel: () => void }} */ ((...args) => {
    latest = args;
    const remaining = Math.max(0, delay - (Date.now() - lastRun));
    if (remaining === 0) {
      if (timer !== undefined) clearTimeout(timer);
      invoke();
    } else if (timer === undefined) {
      timer = setTimeout(invoke, remaining);
    }
  });
  throttled.cancel = cancel;
  return throttled;
}
