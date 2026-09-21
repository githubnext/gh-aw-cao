/**
 * Reactive store that binds one dashboard query result to one reactive state,
 * so views can render before their queries resolve and update each bound UI
 * element independently as results arrive.
 */

import { batch, state, untracked } from './reactive.js';
import { createDebug } from './debug.js';

const debug = createDebug('data:source-store');

/** @typedef {import('./presenter.js').LogicalSourceInput} LogicalSourceInput */

/**
 * `origin` records whether rows were handed over by an already rendered view
 * (already filtered by the presenter) or loaded directly from a query, which
 * still needs the view's own row filter applied.
 * `missing` records a query that resolved without rows because the dashboard
 * data does not carry that source, which is not a load failure.
 * @typedef {{ status: 'idle'|'loading'|'ready'|'missing'|'failed', origin: 'view'|'query', source: LogicalSourceInput | null }} SourceEntry
 */

/** @type {SourceEntry} */
const IDLE_ENTRY = { status: 'idle', origin: 'query', source: null };

/** @type {Map<string, import('./reactive.js').State<SourceEntry>>} */
const entries = new Map();
/** @typedef {{ pageId?: string, viewId?: string, sourceIndex?: number, bindingKey?: string, queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string }, viewMode?: 'chart'|'table'|'card' } }} SourceRequestOptions */

/** @type {Set<string>} */
const requested = new Set();
/** @type {Map<string, SourceRequestOptions>} */
const requestOptions = new Map();
/** @type {Map<string, string>} */
const requestKeys = new Map();
/** @type {Map<string, string>} */
const requestNames = new Map();
/**
 * Generation of the newest load started per source, so stale results are
 * dropped when queries resolve out of order.
 * @type {Map<string, number>}
 */
const generations = new Map();
/** @type {((name: string, options?: SourceRequestOptions) => Promise<LogicalSourceInput | undefined>) | null} */
let loadSource = null;
/** @type {((requests: Array<{ name: string, bindingKey: string, options: SourceRequestOptions }>) => Promise<Record<string, LogicalSourceInput | undefined>>) | null} */
let loadSources = null;
/** @type {Set<string>} */
const batched = new Set();
/** @type {Set<string>} */
const pendingBatch = new Set();
let batchScheduled = false;

/**
 * @param {string} name
 * @returns {import('./reactive.js').State<SourceEntry>}
 */
export function sourceState(name) {
  let entry = entries.get(name);
  if (!entry) {
    entry = state(IDLE_ENTRY);
    entries.set(name, entry);
  }
  return entry;
}

/**
 * Publishes rows a rendered view already holds, so bound elements render them
 * without waiting for a query round trip.
 * @param {string} name
 * @param {LogicalSourceInput} source
 * @param {string} [bindingKey]
 */
export function publishSource(name, source, bindingKey = name) {
  sourceState(bindingKey).set({ status: 'ready', origin: 'view', source });
}

/**
 * Registers the loader used to resolve one named query at a time. Each source
 * is requested on its own so a slow query never delays a fast one.
 * @param {((name: string, options?: SourceRequestOptions) => Promise<LogicalSourceInput | undefined>) | null} loader
 * @param {((requests: Array<{ name: string, bindingKey: string, options: SourceRequestOptions }>) => Promise<Record<string, LogicalSourceInput | undefined>>) | null} [batchLoader]
 */
export function configureSourceLoader(loader, batchLoader = null) {
  loadSource = loader;
  loadSources = batchLoader;
}

/**
 * Requests one source asynchronously when a loader is configured. Repeated
 * requests for the same source reuse the first in-flight query.
 * @param {string} name
 * @param {SourceRequestOptions} [options]
 */
export function requestSource(name, options = {}) {
  if (!loadSource) return;
  const bindingKey = options.bindingKey ?? name;
  const key = JSON.stringify(options);
  if (requested.has(bindingKey) && requestKeys.get(bindingKey) === key) return;
  requested.add(bindingKey);
  requestNames.set(bindingKey, name);
  requestOptions.set(bindingKey, options);
  requestKeys.set(bindingKey, key);
  void loadRequestedSource(bindingKey);
}

/**
 * Requests a set of independently bound sources in one worker query while
 * preserving per-source reactive updates.
 * @param {Array<{ name: string, options?: SourceRequestOptions }>} requests
 */
export function requestSources(requests) {
  if (!loadSource) return;
  for (const { name, options = {} } of requests) {
    const bindingKey = options.bindingKey ?? name;
    const key = JSON.stringify(options);
    if (requested.has(bindingKey) && requestKeys.get(bindingKey) === key) continue;
    requested.add(bindingKey);
    batched.add(bindingKey);
    requestNames.set(bindingKey, name);
    requestOptions.set(bindingKey, options);
    requestKeys.set(bindingKey, key);
    pendingBatch.add(bindingKey);
  }
  scheduleBatch();
}

function scheduleBatch() {
  if (batchScheduled || pendingBatch.size === 0) return;
  batchScheduled = true;
  queueMicrotask(() => {
    batchScheduled = false;
    const bindingKeys = [...pendingBatch];
    pendingBatch.clear();
    void loadRequestedSources(bindingKeys);
  });
}

/** Re-runs every previously requested query, for example after live data changes. */
export function refreshSources() {
  // Grouped so bound elements run once for the whole refresh rather than once
  // per source that flips to loading.
  batch(() => {
    for (const name of [...requested]) {
      if (batched.has(name)) pendingBatch.add(name);
      else void loadRequestedSource(name);
    }
  });
  scheduleBatch();
}

/** @param {string} bindingKey */
async function loadRequestedSource(bindingKey) {
  const loader = loadSource;
  if (!loader) return;
  const name = requestNames.get(bindingKey) ?? bindingKey;
  const entry = sourceState(bindingKey);
  // Rows handed over by a rendered view are refreshed by the next render, so a
  // query result must not silently replace them with unfiltered rows.
  const current = untracked(() => entry.get());
  if (current.origin === 'view' && current.status === 'ready') return;
  const generation = (generations.get(bindingKey) ?? 0) + 1;
  generations.set(bindingKey, generation);
  // Ready rows stay on screen while they reload, and a source already loading
  // is left alone so bound elements are not woken for an unchanged state.
  if (current.status !== 'ready' && current.status !== 'loading') {
    entry.set({ status: 'loading', origin: 'query', source: null });
  }
  try {
    const source = await loader(name, requestOptions.get(bindingKey));
    // A later load already started, so this result is stale.
    if (generations.get(bindingKey) !== generation) return;
    entry.set(source
      ? { status: 'ready', origin: 'query', source }
      : { status: 'missing', origin: 'query', source: null });
    debug('resolved', { source: name, rows: source?.rows?.length ?? 0 });
  } catch (error) {
    if (generations.get(bindingKey) !== generation) return;
    entry.set({ status: 'failed', origin: 'query', source: null });
    debug('failed', { source: name, message: error instanceof Error ? error.message : String(error) });
  }
}

/** @param {string[]} bindingKeys */
async function loadRequestedSources(bindingKeys) {
  const loader = loadSources;
  if (!loader) {
    await Promise.all(bindingKeys.map((bindingKey) => loadRequestedSource(bindingKey)));
    return;
  }
  const loads = bindingKeys.flatMap((bindingKey) => {
    const entry = sourceState(bindingKey);
    const current = untracked(() => entry.get());
    if (current.origin === 'view' && current.status === 'ready') return [];
    const generation = (generations.get(bindingKey) ?? 0) + 1;
    generations.set(bindingKey, generation);
    if (current.status !== 'ready' && current.status !== 'loading') {
      entry.set({ status: 'loading', origin: 'query', source: null });
    }
    return [{
      name: requestNames.get(bindingKey) ?? bindingKey,
      bindingKey,
      options: requestOptions.get(bindingKey) ?? {},
      generation,
      entry
    }];
  });
  if (loads.length === 0) return;
  try {
    const results = await loader(loads.map(({ name, bindingKey, options }) => ({ name, bindingKey, options })));
    batch(() => {
      for (const { bindingKey, generation, entry } of loads) {
        if (generations.get(bindingKey) !== generation) continue;
        const source = results[bindingKey];
        entry.set(source
          ? { status: 'ready', origin: 'query', source }
          : { status: 'missing', origin: 'query', source: null });
        debug('resolved', { source: requestNames.get(bindingKey) ?? bindingKey, rows: source?.rows?.length ?? 0 });
      }
    });
  } catch (error) {
    batch(() => {
      for (const { bindingKey, generation, entry } of loads) {
        if (generations.get(bindingKey) !== generation) continue;
        entry.set({ status: 'failed', origin: 'query', source: null });
        debug('failed', {
          source: requestNames.get(bindingKey) ?? bindingKey,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }
}

/**
 * Forgets the state bound to the named sources so a new render starts from the
 * queries again.
 * @param {Iterable<string>} names
 */
export function clearSources(names) {
  for (const name of names) {
    entries.delete(name);
    requested.delete(name);
    requestOptions.delete(name);
    requestKeys.delete(name);
    requestNames.delete(name);
    generations.delete(name);
    batched.delete(name);
    pendingBatch.delete(name);
  }
}

/** Releases every bound source and the configured loader. */
export function resetSourceStore() {
  entries.clear();
  requested.clear();
  requestOptions.clear();
  requestKeys.clear();
  requestNames.clear();
  generations.clear();
  batched.clear();
  pendingBatch.clear();
  batchScheduled = false;
  loadSource = null;
  loadSources = null;
}
