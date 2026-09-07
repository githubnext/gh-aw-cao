import { h } from '../dom.js';

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_ESTIMATED_SIZE = 56;
const DEFAULT_OVERSCAN = 5;
const DEFAULT_THRESHOLD = 40;
const controllers = new WeakMap();

/**
 * Renders a bounded-DOM collection. The default list mode is suitable for
 * notification feeds; `tagName: 'tbody'` preserves native table semantics.
 *
 * @param {{
 *   items: unknown[],
 *   renderItem: (item: unknown, index: number) => HTMLElement,
 *   key: (item: unknown, index: number) => string,
 *   tagName?: 'ul'|'ol'|'tbody',
 *   className?: string,
 *   colSpan?: number,
 *   estimatedItemSize?: number,
 *   batchSize?: number,
 *   overscan?: number,
 *   threshold?: number
 * }} options
 * @returns {HTMLElement}
 */
export function renderViewportCollection(options) {
  const container = h(options.tagName ?? 'ul', {
    ...(options.className ? { className: options.className } : {}),
    dataset: { viewportCollection: '' }
  });
  const controller = createController(container, options);
  controllers.set(container, controller);
  controller.renderInitial();
  return container;
}

/**
 * @param {HTMLElement} container
 * @param {unknown[]} items
 */
export function updateViewportCollection(container, items, fallbackItems = items) {
  controllers.get(container)?.setItems(items, fallbackItems);
}

/**
 * Disconnects observers owned by viewport collections at or below `root`.
 * @param {Element} root
 */
export function disconnectViewportCollections(root) {
  const collections = [
    ...(root.matches('[data-viewport-collection]') ? [root] : []),
    ...root.querySelectorAll('[data-viewport-collection]')
  ];
  for (const collection of collections) {
    if (collection instanceof HTMLElement) controllers.get(collection)?.destroy();
  }
}

/**
 * @param {HTMLElement} container
 * @param {Parameters<typeof renderViewportCollection>[0]} options
 */
function createController(container, options) {
  let items = [...options.items];
  const renderItem = options.renderItem;
  const key = options.key;
  const colSpan = Math.max(1, options.colSpan ?? 1);
  const estimate = Math.max(1, options.estimatedItemSize ?? DEFAULT_ESTIMATED_SIZE);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const overscan = Math.max(0, options.overscan ?? DEFAULT_OVERSCAN);
  const threshold = Math.max(batchSize, options.threshold ?? DEFAULT_THRESHOLD);
  const tableMode = container.tagName === 'TBODY';
  const measuredSizes = new Map();
  /** @type {Float64Array} */
  let offsets = new Float64Array(1);
  /** @type {HTMLElement[]} */
  let renderedItems = [];
  /** @type {IntersectionObserver | null} */
  let intersectionObserver = null;
  /** @type {ResizeObserver | null} */
  let resizeObserver = null;
  /** @type {HTMLElement | Window | null} */
  let scrollRoot = null;
  let frame = 0;
  let start = 0;
  let end = 0;
  let activeKey = '';
  let activeSlot = -1;
  let fallbackItems = items;

  const rebuildOffsets = () => {
    offsets = new Float64Array(items.length + 1);
    for (let index = 0; index < items.length; index += 1) {
      offsets[index + 1] = offsets[index] + (measuredSizes.get(key(items[index], index)) ?? estimate);
    }
  };

  /** @param {number} size @param {string} edge */
  const spacer = (size, edge) => {
    const style = `height:${Math.max(0, size)}px;padding:0;border:0`;
    if (tableMode) {
      return h('tr', {
        className: `viewport-spacer viewport-spacer-${edge}`,
        'aria-hidden': 'true',
        role: 'presentation'
      }, h('td', { colSpan, style }));
    }
    return h('li', {
      className: `viewport-spacer viewport-spacer-${edge}`,
      'aria-hidden': 'true',
      role: 'presentation',
      style
    });
  };

  /** @param {number} value */
  const lowerBound = (value) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const viewport = () => {
    const bounds = container.getBoundingClientRect();
    if (scrollRoot instanceof HTMLElement) {
      const rootBounds = scrollRoot.getBoundingClientRect();
      return {
        start: Math.max(0, rootBounds.top - bounds.top),
        end: Math.max(0, rootBounds.bottom - bounds.top)
      };
    }
    const height = container.ownerDocument.defaultView?.innerHeight ?? 0;
    return { start: Math.max(0, -bounds.top), end: Math.max(0, height - bounds.top) };
  };

  const rememberFocus = () => {
    const active = container.ownerDocument.activeElement;
    if (!(active instanceof Element)) return;
    const row = active.closest('[data-viewport-key]');
    if (!(row instanceof HTMLElement) || !container.contains(row)) return;
    activeKey = row.dataset.viewportKey ?? '';
    activeSlot = [...row.querySelectorAll(FOCUSABLE_SELECTOR)].indexOf(active);
  };

  const restoreFocus = () => {
    if (!activeKey || activeSlot < 0) return;
    const row = renderedItems.find((item) => item.dataset.viewportKey === activeKey);
    const target = row?.querySelectorAll(FOCUSABLE_SELECTOR)[activeSlot];
    if (target instanceof HTMLElement && container.ownerDocument.activeElement === container) {
      target.focus({ preventScroll: true });
      container.removeAttribute('tabindex');
      activeKey = '';
      activeSlot = -1;
    }
  };

  /** @param {number} nextStart @param {number} nextEnd */
  const renderWindow = (nextStart, nextEnd) => {
    rememberFocus();
    const focusedKey = activeKey;
    const focusedIndex = focusedKey
      ? items.findIndex((item, index) => key(item, index) === focusedKey)
      : -1;
    if (focusedIndex >= 0) {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    start = nextStart;
    end = nextEnd;
    renderedItems = items.slice(start, end).map((item, relativeIndex) => {
      const index = start + relativeIndex;
      const rendered = renderItem(item, index);
      rendered.dataset.viewportKey = key(item, index);
      rendered.dataset.viewportIndex = String(index);
      if (tableMode) rendered.setAttribute('aria-rowindex', String(index + 2));
      return rendered;
    });
    container.replaceChildren(
      spacer(offsets[start] ?? 0, 'start'),
      ...renderedItems,
      spacer((offsets[items.length] ?? 0) - (offsets[end] ?? 0), 'end')
    );
    for (const row of renderedItems) resizeObserver?.observe(row);
    const first = renderedItems[0];
    const last = renderedItems.at(-1);
    if (first) intersectionObserver?.observe(first);
    if (last && last !== first) intersectionObserver?.observe(last);
    restoreFocus();
  };

  const updateWindow = () => {
    frame = 0;
    if (!container.isConnected || items.length <= threshold || !scrollRoot) return;
    const visible = viewport();
    const first = Math.max(0, lowerBound(visible.start) - overscan);
    const last = Math.min(items.length, lowerBound(visible.end) + overscan + 1);
    const nextStart = Math.floor(first / batchSize) * batchSize;
    const nextEnd = Math.min(items.length, Math.ceil(last / batchSize) * batchSize);
    if (nextStart !== start || nextEnd !== end) renderWindow(nextStart, nextEnd);
  };

  const schedule = () => {
    if (frame) return;
    const view = container.ownerDocument.defaultView;
    frame = view?.requestAnimationFrame(updateWindow) ?? 0;
    if (!frame) updateWindow();
  };

  const initializeObservers = () => {
    if (!container.isConnected || items.length <= threshold) return;
    const view = container.ownerDocument.defaultView;
    const scroll = container.closest('.table-scroll');
    scrollRoot = scroll instanceof HTMLElement ? scroll : view;
    if (typeof view?.IntersectionObserver === 'function') {
      intersectionObserver = new view.IntersectionObserver(schedule, {
        root: scroll instanceof HTMLElement ? scroll : null,
        rootMargin: '320px 0px'
      });
    }
    if (typeof view?.ResizeObserver === 'function') {
      resizeObserver = new view.ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const itemKey = entry.target instanceof HTMLElement ? entry.target.dataset.viewportKey : '';
          const size = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (itemKey && size > 0 && measuredSizes.get(itemKey) !== size) {
            measuredSizes.set(itemKey, size);
            changed = true;
          }
        }
        if (changed) {
          rebuildOffsets();
          const topSpacer = container.querySelector('.viewport-spacer-start');
          const bottomSpacer = container.querySelector('.viewport-spacer-end');
          setSpacerSize(topSpacer, offsets[start] ?? 0, tableMode);
          setSpacerSize(bottomSpacer, (offsets[items.length] ?? 0) - (offsets[end] ?? 0), tableMode);
          schedule();
        }
      });
    }
    scrollRoot?.addEventListener('scroll', schedule, { passive: true });
    renderWindow(0, Math.min(items.length, batchSize * 2));
    schedule();
  };

  return {
    renderInitial() {
      rebuildOffsets();
      const view = container.ownerDocument.defaultView;
      const supported = typeof view?.IntersectionObserver === 'function'
        && typeof view.ResizeObserver === 'function'
        && typeof view.requestAnimationFrame === 'function';
      if (items.length <= threshold || !supported) {
        renderedItems = fallbackItems.map((item, index) => renderItem(item, index));
        container.replaceChildren(...renderedItems);
      } else {
        renderWindow(0, Math.min(items.length, batchSize * 2));
        queueMicrotask(initializeObservers);
      }
      if (tableMode) {
        queueMicrotask(() => container.closest('table')?.setAttribute('aria-rowcount', String(items.length + 1)));
      }
    },
    /** @param {unknown[]} nextItems @param {unknown[]} [nextFallbackItems] */
    setItems(nextItems, nextFallbackItems = nextItems) {
      items = [...nextItems];
      fallbackItems = [...nextFallbackItems];
      rebuildOffsets();
      this.destroy();
      this.renderInitial();
    },
    destroy() {
      intersectionObserver?.disconnect();
      resizeObserver?.disconnect();
      scrollRoot?.removeEventListener('scroll', schedule);
      const view = container.ownerDocument.defaultView;
      if (frame && view) view.cancelAnimationFrame(frame);
      intersectionObserver = null;
      resizeObserver = null;
      scrollRoot = null;
      frame = 0;
    }
  };
}

const FOCUSABLE_SELECTOR = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * @param {Element | null} spacer
 * @param {number} size
 * @param {boolean} tableMode
 */
function setSpacerSize(spacer, size, tableMode) {
  const target = tableMode ? spacer?.firstElementChild : spacer;
  if (target instanceof HTMLElement) target.style.height = `${Math.max(0, size)}px`;
}
