import { h } from '../dom.js';

const renderers = new WeakMap();
const hydrationPromises = new WeakMap();
const observers = new WeakMap();
const activeTransitions = new WeakMap();
const hydrationQueues = new WeakMap();

/**
 * @param {Document} document
 * @param {unknown} transition
 */
export function trackViewTransition(document, transition) {
  if (!transition || typeof transition !== 'object' || !('finished' in transition)) return;
  const transitionRecord = /** @type {{ finished?: unknown, ready?: unknown, updateCallbackDone?: unknown }} */ (transition);
  observeTransitionPromise(transitionRecord.ready);
  observeTransitionPromise(transitionRecord.updateCallbackDone);
  const finished = Promise.resolve(transitionRecord.finished).catch(() => {});
  activeTransitions.set(document, finished);
  void finished.then(() => {
    if (activeTransitions.get(document) === finished) activeTransitions.delete(document);
  });
}

/**
 * @param {unknown} value
 */
function observeTransitionPromise(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  void Promise.resolve(value).catch((error) => {
    if (isSkippedTransitionError(error)) return;
    queueMicrotask(() => {
      throw error;
    });
  });
}

/**
 * @param {unknown} error
 */
function isSkippedTransitionError(error) {
  if (!error || typeof error !== 'object') return false;
  const transitionError = /** @type {{ name?: unknown, message?: unknown }} */ (error);
  return transitionError.name === 'AbortError'
    || typeof transitionError.message === 'string' && /skip/i.test(transitionError.message);
}

/**
 * @param {{ label: string, headingLevel?: 'h3'|'h4', minHeight?: number, render: () => HTMLElement | Promise<HTMLElement> }} options
 * @returns {HTMLElement}
 */
export function renderLazyView({ label, headingLevel = 'h3', minHeight = 280, render }) {
  const element = h(
    'div',
    {
      className: 'dashboard-lazy-view',
      role: 'region',
      tabIndex: 0,
      'aria-busy': 'true',
      'aria-label': `Loading ${label}`,
      dataset: { lazyView: '' },
      style: `--dashboard-lazy-view-min-height: ${Math.max(1, minHeight)}px`
    },
    h(headingLevel, { className: 'sr-only' }, label),
    h('span', { className: 'sr-only' }, `Loading ${label}`),
    h(
      'div',
      { className: 'dashboard-lazy-view-skeleton', 'aria-hidden': 'true' },
      h('span'),
      h('span'),
      h('span')
    )
  );
  renderers.set(element, render);
  console.debug('[lazy-view] placeholder rendered', label);
  return element;
}

/**
 * Starts viewport observation for lazy views below a rendered page.
 * Browsers without IntersectionObserver render immediately.
 * @param {HTMLElement} root
 */
export function enableLazyViews(root) {
  disconnectLazyViews(root);
  const lazyViews = [...root.querySelectorAll('[data-lazy-view]')]
    .filter((element) => element instanceof HTMLElement);
  if (lazyViews.length === 0) return;
  console.debug('[lazy-view] observing views', lazyViews.length);

  const Observer = root.ownerDocument.defaultView?.IntersectionObserver;
  if (typeof Observer !== 'function') {
    console.debug('[lazy-view] IntersectionObserver unavailable, hydrating immediately');
    for (const element of lazyViews) void hydrateLazyView(element, { immediate: true });
    return;
  }

  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
      observer.unobserve(entry.target);
      if (entry.target instanceof HTMLElement) {
        console.debug('[lazy-view] hydrating on intersection', entry.target.getAttribute('data-view-id'));
        void hydrateLazyView(entry.target);
      }
    }
  }, { rootMargin: '320px 0px' });
  observers.set(root, observer);
  for (const element of lazyViews) {
    observer.observe(element);
    const disclosure = element.closest('details');
    disclosure?.addEventListener('toggle', () => {
      if (disclosure.open) {
        observer.unobserve(element);
        console.debug('[lazy-view] hydrating on disclosure', element.getAttribute('data-view-id'));
        void hydrateLazyView(element);
      }
    }, { once: true });
    element.addEventListener('focusin', () => {
      observer.unobserve(element);
      console.debug('[lazy-view] hydrating on focus', element.getAttribute('data-view-id'));
      void hydrateLazyView(element);
    }, { once: true });
  }
}

/**
 * @param {HTMLElement} root
 */
export function disconnectLazyViews(root) {
  if (observers.has(root)) console.debug('[lazy-view] disconnecting observer');
  observers.get(root)?.disconnect();
  observers.delete(root);
}

/**
 * @param {HTMLElement} element
 * @param {{ immediate?: boolean }} [options]
 * @returns {Promise<void>}
 */
function hydrateLazyView(element, { immediate = false } = {}) {
  const existing = hydrationPromises.get(element);
  if (existing) return existing;

  const render = renderers.get(element);
  if (!render || !element.parentNode) return Promise.resolve();
  const viewId = element.getAttribute('data-view-id');
  const ownerDocument = element.ownerDocument;

  if (immediate && !activeTransitions.has(ownerDocument)) {
    const hydration = renderHydratedView(element, render, viewId);
    hydrationPromises.set(element, hydration);
    return hydration;
  }

  const hydration = queueHydration(ownerDocument, async () => {
    const transition = activeTransitions.get(ownerDocument);
    if (transition) {
      console.debug('[lazy-view] deferring hydration until transition finishes', viewId);
      await transition;
    }
    if (!element.parentNode) return;
    await renderHydratedView(element, render, viewId);
  });

  hydrationPromises.set(element, hydration);
  return hydration;
}

/**
 * @param {HTMLElement} element
 * @param {() => HTMLElement | Promise<HTMLElement>} render
 * @param {string | null} viewId
 * @returns {Promise<void>}
 */
function renderHydratedView(element, render, viewId) {
  console.debug('[lazy-view] hydrating view', viewId);
  try {
    const rendered = render();
    if (rendered instanceof HTMLElement) {
      replaceLazyView(element, rendered);
      console.debug('[lazy-view] hydrated view', viewId);
      return Promise.resolve();
    }
    return Promise.resolve(rendered)
      .then((resolved) => {
        replaceLazyView(element, resolved);
        console.debug('[lazy-view] hydrated view', viewId);
      })
      .catch((error) => reportHydrationError(element, error));
  } catch (error) {
    reportHydrationError(element, error);
    return Promise.resolve();
  }
}

/**
 * Hydrates one view at a time so several offscreen views entering the viewport
 * together render across separate tasks instead of one long, memory-heavy task.
 * @param {Document} ownerDocument
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function queueHydration(ownerDocument, task) {
  const pending = hydrationQueues.get(ownerDocument) ?? Promise.resolve();
  const queued = pending.then(task, task);
  hydrationQueues.set(ownerDocument, queued.then(
    () => yieldBetweenHydrations(ownerDocument),
    () => yieldBetweenHydrations(ownerDocument)
  ));
  return queued.catch((/** @type {unknown} */ error) => {
    console.error(error);
  });
}

/**
 * @param {Document} ownerDocument
 * @returns {Promise<void>}
 */
function yieldBetweenHydrations(ownerDocument) {
  const view = ownerDocument.defaultView;
  return new Promise((resolve) => {
    if (typeof view?.setTimeout === 'function') view.setTimeout(resolve, 0);
    else resolve();
  });
}

/**
 * @param {HTMLElement} element
 * @param {HTMLElement} rendered
 */
function replaceLazyView(element, rendered) {
  if (!element.parentNode) return;
  const restoreFocus = element.ownerDocument.activeElement === element;
  const viewId = element.getAttribute('data-view-id');
  if (viewId && !rendered.hasAttribute('data-view-id')) {
    rendered.setAttribute('data-view-id', viewId);
  }
  element.replaceWith(rendered);
  if (restoreFocus) {
    if (!rendered.hasAttribute('tabindex') && rendered.tabIndex < 0) {
      rendered.tabIndex = -1;
    }
    rendered.focus();
  }
}

/**
 * @param {HTMLElement} element
 * @param {unknown} error
 */
function reportHydrationError(element, error) {
  console.error(error);
  if (!element.parentNode) return;
  element.setAttribute('aria-busy', 'false');
  const label = element.getAttribute('aria-label')?.replace(/^Loading /, '') || 'view';
  element.setAttribute('aria-label', `Unable to load ${label}`);
  const status = element.querySelector('span.sr-only');
  if (status) status.textContent = `Unable to load ${label}`;
}
