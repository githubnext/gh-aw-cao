/**
 * Shared data adapters for the declaratively composed factory elements.
 */

import { batch } from '../reactive.js';
import { publishSource, requestSource, sourceState } from '../source-store.js';
import { dashboardViewAliasName } from '../data/queries/view-payload-compiler.js';

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ rows: () => Row[], source: () => LogicalSourceInput | undefined, pending: () => boolean, empty: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {import('../presenter.js').LogicalSourceInput} LogicalSourceInput */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/**
 * Resolves the actual source name bound to each canonical metric role,
 * applying any `config.sources` overrides declared on the view.
 * @param {Record<string, string>} defaults
 * @param {Record<string, unknown> | undefined} config
 * @returns {Record<string, string>}
 */
export function resolveFactorySourceNames(defaults, config) {
  const overrides = config && typeof config === 'object' && config.sources && typeof config.sources === 'object'
    ? /** @type {Record<string, unknown>} */ (config.sources)
    : {};
  return Object.fromEntries(Object.entries(defaults).map(([role, defaultName]) => {
    const override = overrides[role];
    return [role, typeof override === 'string' && override ? override : defaultName];
  }));
}

/**
 * Binds each declared query independently so the element can render before all
 * worker results settle and update only the widgets that consume each result.
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string[]} names
 * @param {{ pageId?: string, viewId?: string, viewIndex?: number, sourceNames?: string[], queryContext?: import('./ui-elements.js').ElementRenderContext['queryContext'] }} [request]
 * @param {{ refreshViewSources?: boolean }} [options]
 * @returns {SourceBindings}
 */
export function bindFactorySources(sources, names, request, options) {
  batch(() => {
    for (const [sourceIndex, name] of names.entries()) {
      const source = sources[name];
      const declaredSourceIndex = request?.sourceNames?.indexOf(name) ?? -1;
      const effectiveSourceIndex = declaredSourceIndex >= 0 ? declaredSourceIndex : sourceIndex;
      const bindingKey = request?.pageId && request.viewId
        ? dashboardViewAliasName(request.pageId, { id: request.viewId }, request.viewIndex ?? 0, name, effectiveSourceIndex)
        : name;
      if (source && Array.isArray(source.rows)) publishSource(name, source, bindingKey);
      if (!source || options?.refreshViewSources === true) {
        requestSource(name, {
          ...request,
          sourceIndex: effectiveSourceIndex,
          bindingKey,
          refreshViewSource: options?.refreshViewSources === true
        });
      }
    }
  });
  return Object.fromEntries(names.map((name) => {
    const declaredSourceIndex = request?.sourceNames?.indexOf(name) ?? -1;
    const effectiveSourceIndex = declaredSourceIndex >= 0 ? declaredSourceIndex : names.indexOf(name);
    const bindingKey = request?.pageId && request.viewId
      ? dashboardViewAliasName(request.pageId, { id: request.viewId }, request.viewIndex ?? 0, name, effectiveSourceIndex)
      : name;
    const entryState = sourceState(bindingKey);
    return [name, {
      rows: () => entryState.get().source?.rows ?? [],
      source: () => entryState.get().source ?? undefined,
      pending: () => entryState.get().status === 'loading',
      empty: () => entryState.get().source?.metadata?.availability === 'empty',
      unavailable: () => {
        const entry = entryState.get();
        return entry.status === 'failed' || entry.source?.metadata?.availability === 'unavailable';
      }
    }];
  }));
}

/**
 * Creates an abort-scoped lifetime for one independently loaded element.
 */
export function createFactoryScope() {
  const lifetime = new AbortController();
  return {
    signal: lifetime.signal,
    /** @param {HTMLElement} element */
    bind(element) {
      if (typeof MutationObserver !== 'function') return;
      let wasConnected = element.isConnected;
      const observer = new MutationObserver((records) => {
        if (element.isConnected) {
          wasConnected = true;
        } else if (wasConnected || records.some((record) => (
          [...record.addedNodes].some((node) => node === element || (node instanceof Element && node.contains(element)))
        ))) {
          lifetime.abort();
        }
      });
      observer.observe(element.ownerDocument, { childList: true, subtree: true });
      lifetime.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    }
  };
}
