/**
 * @template T
 * @typedef {{ get: () => T, set: (value: T | ((current: T) => T)) => T, subscribe: (listener: () => void) => () => void }} State
 */

/**
 * @typedef {{ run: () => void, schedule: () => void, stop: () => void, _computed: boolean, _registerCleanup: (cleanup: () => void) => void }} EffectHandle
 */

/** @type {EffectHandle | null} */
let activeEffect = null;
let batchDepth = 0;
let flushing = false;
/** @type {Set<EffectHandle>} */
const pendingEffects = new Set();
/** @type {Set<EffectHandle>} */
const pendingComputations = new Set();

function flushEffects() {
  if (batchDepth > 0 || flushing) return;
  flushing = true;
  try {
    while (pendingComputations.size > 0 || pendingEffects.size > 0) {
      const queue = pendingComputations.size > 0 ? pendingComputations : pendingEffects;
      const handle = queue.values().next().value;
      if (!handle) break;
      queue.delete(handle);
      handle.run();
    }
  } finally {
    flushing = false;
  }
}

/**
 * Groups reactive writes so each dependent effect runs once with the final
 * state, matching the transaction semantics used by mature reactive runtimes.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    flushEffects();
  }
}

/**
 * Registers lifecycle cleanup with the currently running effect.
 * @param {() => void} cleanup
 */
export function onCleanup(cleanup) {
  if (!activeEffect) {
    throw new Error('Reactive cleanup must be registered inside an effect.');
  }
  activeEffect._registerCleanup(cleanup);
}

/**
 * @param {() => void} fn
 * @param {{ computed?: boolean }} [options]
 * @returns {EffectHandle}
 */
export function effect(fn, options = {}) {
  /** @type {Set<() => void>} */
  const cleanups = new Set();
  let stopped = false;

  /** @type {EffectHandle} */
  const handle = {
    _computed: options.computed === true,
    run() {
      if (stopped) return;
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.clear();
      const previous = activeEffect;
      activeEffect = handle;
      try {
        fn();
      } finally {
        activeEffect = previous;
      }
    },
    schedule() {
      if (stopped) return;
      if (batchDepth > 0 || flushing) {
        (handle._computed ? pendingComputations : pendingEffects).add(handle);
      } else {
        handle.run();
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      pendingEffects.delete(handle);
      pendingComputations.delete(handle);
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.clear();
      if (activeEffect === handle) {
        activeEffect = null;
      }
    },
    _registerCleanup(cleanup) {
      cleanups.add(cleanup);
    }
  };

  handle.run();
  return handle;
}

/**
 * @template T
 * @param {T} initialValue
 * @returns {State<T>}
 */
export function state(initialValue) {
  let current = initialValue;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  return {
    get() {
      if (activeEffect) {
        const subscriber = activeEffect;
        const listener = () => subscriber.schedule();
        listeners.add(listener);
        subscriber._registerCleanup(() => {
          listeners.delete(listener);
        });
      }
      return current;
    },
    set(value) {
      const next = typeof value === 'function'
        ? /** @type {(current: T) => T} */ (value)(current)
        : value;
      if (Object.is(current, next)) {
        return current;
      }
      current = next;
      for (const listener of [...listeners]) {
        listener();
      }
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/**
 * @template T
 * @typedef {{ get: () => T, dispose: () => void }} Derived
 */

/**
 * @template T
 * @param {() => T} compute
 * @returns {Derived<T>}
 */
export function derived(compute) {
  const value = state(compute());
  const handle = effect(() => {
    value.set(compute());
  }, { computed: true });

  return {
    get() {
      return value.get();
    },
    dispose() {
      handle.stop();
    }
  };
}
