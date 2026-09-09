import { h } from '../dom.js'
import { observeLoadMoreBoundary } from './ui-primitives.js'

/**
 * @template T
 * @param {{
 *   items: () => T[],
 *   batchSize: number,
 *   renderItems: (items: T[]) => Node[],
 *   renderEmpty: () => Node,
 *   afterRender?: () => void
 * }} options
 */
export function renderLazyInfiniteList({ items, batchSize, renderItems, renderEmpty, afterRender = () => {} }) {
  const list = h('div', { className: 'notifications-list' })
  let renderedLimit = batchSize
  /** @type {IntersectionObserver | null} */
  let boundaryObserver = null

  const render = (resetWindow = true) => {
    if (resetWindow) renderedLimit = batchSize
    const currentItems = items()
    const renderedItems = currentItems.slice(0, renderedLimit)
    const remaining = currentItems.length - renderedItems.length
    if (currentItems.length === 0) {
      boundaryObserver?.disconnect()
      list.replaceChildren(renderEmpty())
      afterRender()
      return
    }

    const loadMore = () => {
      renderedLimit = Math.min(items().length, renderedLimit + batchSize)
      render(false)
    }
    const boundary =
      remaining > 0
        ? h(
            'div',
            {
              className: 'notifications-load-boundary',
              dataset: { notificationsLoadBoundary: '' },
            },
            h('span', null, `Showing ${renderedItems.length} of ${currentItems.length}`),
            h('button', { type: 'button', onClick: loadMore }, `Load ${Math.min(batchSize, remaining)} more`),
          )
        : null

    boundaryObserver?.disconnect()
    list.replaceChildren(...renderItems(renderedItems), ...(boundary ? [boundary] : []))
    afterRender()
    if (!boundary) return
    boundaryObserver = observeLoadMoreBoundary(globalThis.IntersectionObserver, boundary, loadMore, {
      rootMargin: `${Number(globalThis.window?.innerHeight) || 768}px 0px`,
    })
  }

  render()
  return { element: list, render }
}
