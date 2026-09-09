/**
 * @template T
 * @typedef {{ get: () => T, set: (value: T | ((current: T) => T)) => T, subscribe: (listener: () => void) => () => void }} State
 */

/**
 * @typedef {{ run: () => void, schedule: () => void, stop: () => void, _registerCleanup: (cleanup: () => void) => void }} EffectHandle
 */

/** @type {EffectHandle | null} */
let activeEffect = null

/**
 * @param {() => void} fn
 * @returns {EffectHandle}
 */
export function effect(fn) {
  /** @type {Set<() => void>} */
  const cleanups = new Set()

  /** @type {EffectHandle} */
  const handle = {
    run() {
      for (const cleanup of cleanups) {
        cleanup()
      }
      cleanups.clear()
      const previous = activeEffect
      activeEffect = handle
      try {
        fn()
      } finally {
        activeEffect = previous
      }
    },
    schedule() {
      handle.run()
    },
    stop() {
      for (const cleanup of cleanups) {
        cleanup()
      }
      cleanups.clear()
      if (activeEffect === handle) {
        activeEffect = null
      }
    },
    _registerCleanup(cleanup) {
      cleanups.add(cleanup)
    },
  }

  handle.run()
  return handle
}

/**
 * @template T
 * @param {T} initialValue
 * @returns {State<T>}
 */
export function state(initialValue) {
  let current = initialValue
  /** @type {Set<() => void>} */
  const listeners = new Set()

  return {
    get() {
      if (activeEffect) {
        const subscriber = activeEffect
        const listener = () => subscriber.schedule()
        listeners.add(listener)
        subscriber._registerCleanup(() => {
          listeners.delete(listener)
        })
      }
      return current
    },
    set(value) {
      const next =
        typeof value === 'function'
          ? /** @type {(current: T) => T} */ (value)(current)
          : value
      if (Object.is(current, next)) {
        return current
      }
      current = next
      for (const listener of [...listeners]) {
        listener()
      }
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
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
  const value = state(compute())
  const handle = effect(() => {
    value.set(compute())
  })

  return {
    get() {
      return value.get()
    },
    dispose() {
      handle.stop()
    },
  }
}
