import { h } from '../dom.js';

/**
 * @template T
 * @param {{
 *   items: () => T[],
 *   batchSize: number,
 *   renderItems: (items: T[]) => Node[],
 *   renderEmpty: () => Node
 * }} options
 */
export function renderLazyInfiniteList({ items, batchSize, renderItems, renderEmpty }) {
  const list = h('div', { className: 'notifications-list' });
  let renderedLimit = batchSize;
  /** @type {IntersectionObserver | null} */
  let boundaryObserver = null;

  const render = (resetWindow = true) => {
    if (resetWindow) renderedLimit = batchSize;
    const currentItems = items();
    const renderedItems = currentItems.slice(0, renderedLimit);
    const remaining = currentItems.length - renderedItems.length;
    if (currentItems.length === 0) {
      boundaryObserver?.disconnect();
      list.replaceChildren(renderEmpty());
      return;
    }

    const loadMore = () => {
      renderedLimit = Math.min(items().length, renderedLimit + batchSize);
      render(false);
    };
    const boundary = remaining > 0 ? h('div', {
      className: 'notifications-load-boundary',
      dataset: { notificationsLoadBoundary: '' }
    },
    h('span', null, `Showing ${renderedItems.length} of ${currentItems.length}`),
    h('button', { type: 'button', onClick: loadMore }, `Load ${Math.min(batchSize, remaining)} more`)) : null;

    boundaryObserver?.disconnect();
    list.replaceChildren(...renderItems(renderedItems), ...(boundary ? [boundary] : []));
    if (!boundary || typeof globalThis.IntersectionObserver !== 'function') return;
    boundaryObserver = new globalThis.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: `${Number(globalThis.window?.innerHeight) || 768}px 0px` });
    boundaryObserver.observe(boundary);
  };

  render();
  return { element: list, render };
}
