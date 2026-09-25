/**
 * @template {unknown[]} Args
 * @param {(...args: Args) => void} callback
 * @param {number} delay
 * @returns {((...args: Args) => void) & { cancel: () => void }}
 */
export function debounce(callback, delay) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const cancel = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const debounced = /** @type {((...args: Args) => void) & { cancel: () => void }} */ ((...args) => {
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
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
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    latest = undefined;
  };
  const invoke = () => {
    timer = undefined;
    if (!latest) return;
    const args = latest;
    latest = undefined;
    lastRun = Date.now();
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
