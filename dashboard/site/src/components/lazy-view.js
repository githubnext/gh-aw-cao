import { h } from '../dom.js';

const renderers = new WeakMap();
const hydrationPromises = new WeakMap();
const observers = new WeakMap();
const activeTransitions = new WeakMap();

/**
 * @param {Document} document
 * @param {unknown} transition
 */
export function trackViewTransition(document, transition) {
  if (!transition || typeof transition !== 'object' || !('finished' in transition)) return;
  const finished = Promise.resolve(transition.finished).catch(() => {});
  activeTransitions.set(document, finished);
  void finished.finally(() => {
    if (activeTransitions.get(document) === finished) activeTransitions.delete(document);
  });
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
      role: 'status',
      tabIndex: 0,
      'aria-busy': 'true',
      'aria-label': `Loading ${label}`,
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

  const Observer = root.ownerDocument.defaultView?.IntersectionObserver;
  if (typeof Observer !== 'function') {
    for (const element of lazyViews) void hydrateLazyView(element);
    return;
  }

  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
      observer.unobserve(entry.target);
      if (entry.target instanceof HTMLElement) void hydrateLazyView(entry.target);
    }
  }, { rootMargin: '320px 0px' });
  observers.set(root, observer);
  for (const element of lazyViews) {
    observer.observe(element);
    const disclosure = element.closest('details');
    disclosure?.addEventListener('toggle', () => {
      if (disclosure.open) {
        observer.unobserve(element);
        void hydrateLazyView(element);
      }
    }, { once: true });
    element.addEventListener('focusin', () => {
      observer.unobserve(element);
      void hydrateLazyView(element);
    }, { once: true });
  }
}

/**
 * @param {HTMLElement} root
 */
export function disconnectLazyViews(root) {
  observers.get(root)?.disconnect();
  observers.delete(root);
}

/**
 * @param {HTMLElement} element
 * @returns {Promise<void>}
 */
function hydrateLazyView(element) {
  const existing = hydrationPromises.get(element);
  if (existing) return existing;

  const replace = async () => {
    if (!element.parentNode) return;
    const render = renderers.get(element);
    if (!render) return;
    const rendered = await render();
    if (!element.parentNode) return;
    const restoreFocus = element.ownerDocument.activeElement === element;
    element.replaceWith(rendered);
    if (restoreFocus) {
      rendered.tabIndex = -1;
      rendered.focus();
    }
  };
  const transition = activeTransitions.get(element.ownerDocument);
  if (!transition) {
    const render = renderers.get(element);
    if (!render || !element.parentNode) return Promise.resolve();
    const rendered = render();
    if (rendered instanceof HTMLElement) {
      const restoreFocus = element.ownerDocument.activeElement === element;
      element.replaceWith(rendered);
      if (restoreFocus) {
        rendered.tabIndex = -1;
        rendered.focus();
      }
      const hydration = Promise.resolve();
      hydrationPromises.set(element, hydration);
      return hydration;
    }
    const hydration = Promise.resolve(rendered).then((resolved) => {
      if (!element.parentNode) return;
      const restoreFocus = element.ownerDocument.activeElement === element;
      element.replaceWith(resolved);
      if (restoreFocus) {
        resolved.tabIndex = -1;
        resolved.focus();
      }
    });
    hydrationPromises.set(element, hydration);
    return hydration;
  }

  const hydration = transition.then(replace);
  hydrationPromises.set(element, hydration);
  return hydration;
}
