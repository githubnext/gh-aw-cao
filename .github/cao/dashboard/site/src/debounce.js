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
