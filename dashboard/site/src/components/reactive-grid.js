import { h, keyed } from '../dom.js';
import { effect } from '../reactive.js';
import { createDebug } from '../debug.js';

const debugReactiveGrid = createDebug('reactive-grid');

/**
 * Renders a keyed grid whose items own their updates while the grid owns
 * collection order and aggregate reactive state.
 * @template T
 * @param {{
 *   className?: string,
 *   activeClassName?: string,
 *   listClassName?: string,
 *   items: () => T[],
 *   key: (item: T, index: number) => string,
 *   renderItem: (item: T, index: number) => Node,
 *   active?: () => boolean,
 *   ariaLabel?: () => string,
 *   signal: AbortSignal
 * }} options
 * @returns {HTMLElement}
 */
export function renderReactiveGrid(options) {
  const rootClassName = ['reactive-grid', options.className].filter(Boolean).join(' ');
  const items = keyed([], options.renderItem, options.key);
  const list = h(
    'ol',
    { className: ['reactive-grid-items', options.listClassName].filter(Boolean).join(' ') },
    items
  );
  const root = h('section', { className: rootClassName }, list);

  debugReactiveGrid({ event: 'composed', className: options.className ?? '' });

  /** @type {number | undefined} */
  let previousCount;
  /** @type {boolean | undefined} */
  let previousActive;
  effect(() => {
    const nextItems = options.items();
    items.items = nextItems;
    items.render();
    if (nextItems.length !== previousCount) {
      debugReactiveGrid({ event: 'items-updated', count: nextItems.length });
      previousCount = nextItems.length;
    }
    if (options.activeClassName) {
      const active = options.active?.() ?? false;
      root.classList.toggle(options.activeClassName, active);
      if (active !== previousActive) {
        debugReactiveGrid({ event: 'active-changed', active });
        previousActive = active;
      }
    }
    const ariaLabel = options.ariaLabel?.();
    if (ariaLabel) root.setAttribute('aria-label', ariaLabel);
    else root.removeAttribute('aria-label');
  }, { signal: options.signal });

  return root;
}
