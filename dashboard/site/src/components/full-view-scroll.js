/**
 * Pinned "full-view" table layout: gives a standalone table the full viewport with a
 * sticky header and its own scroll surface, hiding the surrounding app chrome as the
 * table scrolls. A preceding view is squeezed into the remaining space above the table
 * and progressively hidden as the table scrolls, so pinning is only safe when that
 * preceding content has bounded height (a metric card, callout, or compact swimlane like
 * the one above the Runs table). A pie chart's legend list grows with its data and can
 * render taller than the space it is squeezed into (for example on the Cost or Models &
 * Agents pages); since the squeeze container clips overflow instead of scrolling it, that
 * content would become unreachable. In that case the whole page falls back to scrolling
 * normally instead of pinning the table.
 */

const FULL_VIEW_SELECTOR = '.custom-view[data-view-layout="full-view"]';
const UNBOUNDED_SIBLING_SELECTOR = '.pie-chart-card';

/**
 * Toggles `dashboard-full-view` on the dashboard root, scoped to pages where the
 * full-view table has no siblings with unbounded height (e.g. a pie chart).
 * @param {HTMLElement} root
 * @param {HTMLElement | undefined} page
 */
export function syncFullViewMode(root, page) {
  const fullView = page?.querySelector(FULL_VIEW_SELECTOR);
  const siblings = fullView?.parentElement
    ? [...fullView.parentElement.querySelectorAll(':scope > .custom-view')].filter((view) => view !== fullView)
    : [];
  const canPin = Boolean(fullView) && siblings.every((view) => !view.querySelector(UNBOUNDED_SIBLING_SELECTOR));
  root.classList.toggle('dashboard-full-view', canPin);
  if (!canPin) root.classList.remove('dashboard-full-view-scrolled');
}

/**
 * Wires wheel/touch scroll forwarding and app-chrome hiding for the pinned full-view table
 * scroll surface. Forwarding and hiding only engage while `dashboard-full-view` is active.
 * @param {HTMLElement} root
 * @param {(Window & typeof globalThis) | null | undefined} defaultView
 */
export function enableFullViewScrollForwarding(root, defaultView) {
  // Hiding the app chrome while a full-view table scrolls resizes the scroll container.
  // Phone layouts keep the chrome stable because mobile momentum scrolling can turn that
  // reflow into a hide/show feedback loop. Larger layouts use range and hysteresis guards.
  const FULL_VIEW_COMPACT_MEDIA = '(max-width: 700px)';
  const FULL_VIEW_SCROLL_MIN_RANGE = 48;
  const FULL_VIEW_SCROLL_ENTER = 24;
  const FULL_VIEW_SCROLL_EXIT = 4;
  const fullViewCompactMedia = typeof defaultView?.matchMedia === 'function'
    ? defaultView.matchMedia(FULL_VIEW_COMPACT_MEDIA)
    : null;
  fullViewCompactMedia?.addEventListener('change', () => {
    if (fullViewCompactMedia.matches) root.classList.remove('dashboard-full-view-scrolled');
  });
  let fullViewScrollFrame = 0;
  /**
   * Finds the scroll surface of a pinned full-view table following the event target's view.
   * @param {EventTarget | null} target
   * @returns {HTMLElement | null}
   */
  const trailingFullViewScrollTarget = (target) => {
    if (!root.classList.contains('dashboard-full-view') || !(target instanceof Element)) return null;
    const view = target.closest('.custom-view');
    const fullView = view?.parentElement?.querySelector(`:scope > ${FULL_VIEW_SELECTOR}`);
    if (!(view instanceof HTMLElement) || !(fullView instanceof HTMLElement) || view === fullView) return null;
    if (!(view.compareDocumentPosition(fullView) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
    const scroll = fullView.querySelector('.table-scroll');
    return scroll instanceof HTMLElement ? scroll : null;
  };
  /** @param {HTMLElement} scroll @param {number} deltaY */
  const scrollTrailingFullView = (scroll, deltaY) => {
    const previousScrollTop = scroll.scrollTop;
    scroll.scrollTop += deltaY;
    return scroll.scrollTop !== previousScrollTop;
  };
  root.addEventListener('wheel', (event) => {
    const scroll = trailingFullViewScrollTarget(event.target);
    if (!scroll) return;
    const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1);
    if (scrollTrailingFullView(scroll, deltaY)) event.preventDefault();
  }, { capture: true, passive: false });
  /** @type {{ scroll: HTMLElement, clientY: number } | null} */
  let trailingFullViewTouch = null;
  root.addEventListener('touchstart', (event) => {
    const scroll = trailingFullViewScrollTarget(event.target);
    const touch = event.touches[0];
    trailingFullViewTouch = scroll && touch ? { scroll, clientY: touch.clientY } : null;
  }, { capture: true, passive: true });
  root.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (!trailingFullViewTouch || !touch) return;
    const deltaY = trailingFullViewTouch.clientY - touch.clientY;
    trailingFullViewTouch.clientY = touch.clientY;
    if (scrollTrailingFullView(trailingFullViewTouch.scroll, deltaY)) event.preventDefault();
  }, { capture: true, passive: false });
  const endTrailingFullViewTouch = () => {
    trailingFullViewTouch = null;
  };
  root.addEventListener('touchend', endTrailingFullViewTouch, true);
  root.addEventListener('touchcancel', endTrailingFullViewTouch, true);
  root.addEventListener('scroll', (event) => {
    if (!root.classList.contains('dashboard-full-view') || !(event.target instanceof Element)) return;
    const scroll = event.target.closest(`${FULL_VIEW_SELECTOR} .table-scroll`);
    if (scroll !== event.target) return;
    const syncScrolledState = () => {
      fullViewScrollFrame = 0;
      if (!scroll.isConnected || !root.classList.contains('dashboard-full-view')) return;
      if (fullViewCompactMedia?.matches) {
        root.classList.remove('dashboard-full-view-scrolled');
        return;
      }
      const scrollableRange = scroll.scrollHeight - scroll.clientHeight;
      if (scrollableRange < FULL_VIEW_SCROLL_MIN_RANGE) {
        root.classList.remove('dashboard-full-view-scrolled');
        return;
      }
      const wasScrolled = root.classList.contains('dashboard-full-view-scrolled');
      const threshold = wasScrolled ? FULL_VIEW_SCROLL_EXIT : FULL_VIEW_SCROLL_ENTER;
      root.classList.toggle('dashboard-full-view-scrolled', scroll.scrollTop > threshold);
    };
    if (defaultView?.requestAnimationFrame) {
      if (fullViewScrollFrame) defaultView.cancelAnimationFrame(fullViewScrollFrame);
      fullViewScrollFrame = defaultView.requestAnimationFrame(syncScrolledState);
    } else {
      queueMicrotask(syncScrolledState);
    }
  }, true);
}
