/**
 * Pinned "full-view" table layout: gives a standalone table the full viewport with a
 * sticky header and its own scroll surface, hiding the surrounding app chrome as the
 * table scrolls. A preceding view is squeezed into the remaining space above the table
 * and progressively hidden as the table scrolls. Pages with a chart before the table use
 * normal page scrolling instead, keeping the chart reachable and making chart-plus-table
 * pages such as Runs and Cost behave consistently.
 */

const FULL_VIEW_SELECTOR = '.custom-view[data-view-layout="full-view"]';
const CHART_SIBLING_SELECTOR = '.chart-widget';

/**
 * Toggles `dashboard-full-view` on the dashboard root, scoped to pages where the
 * full-view table has no chart siblings.
 * @param {HTMLElement} root
 * @param {HTMLElement | undefined} page
 */
export function syncFullViewMode(root, page) {
  const fullView = page?.querySelector(FULL_VIEW_SELECTOR);
  const siblings = fullView?.parentElement
    ? [...fullView.parentElement.querySelectorAll(':scope > .custom-view')].filter((view) => view !== fullView)
    : [];
  const selectedFullViewMode = ['table', 'card'].includes(page?.dataset.viewMode ?? '');
  const canPin = Boolean(fullView) && (
    selectedFullViewMode
    || siblings.every((view) => !view.querySelector(CHART_SIBLING_SELECTOR))
  );
  root.classList.toggle('dashboard-full-view', canPin);
  if (!canPin) root.classList.remove('dashboard-full-view-scrolled');
}

/**
 * Wires wheel/touch scroll forwarding and app-chrome hiding for the pinned full-view table
 * scroll surface. Forwarding and hiding only engage while `dashboard-full-view` is active.
 * @param {HTMLElement} root
 * @param {(Window & typeof globalThis) | null | undefined} defaultView
 * @returns {() => void}
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
  const onCompactViewChange = () => {
    if (fullViewCompactMedia?.matches) root.classList.remove('dashboard-full-view-scrolled');
  };
  fullViewCompactMedia?.addEventListener('change', onCompactViewChange);
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
  /** @param {WheelEvent} event */
  const onWheel = (event) => {
    const scroll = trailingFullViewScrollTarget(event.target);
    if (!scroll) return;
    const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1);
    if (scrollTrailingFullView(scroll, deltaY)) event.preventDefault();
  };
  root.addEventListener('wheel', onWheel, { capture: true, passive: false });
  /** @type {{ scroll: HTMLElement, clientY: number } | null} */
  let trailingFullViewTouch = null;
  /** @param {TouchEvent} event */
  const onTouchStart = (event) => {
    const scroll = trailingFullViewScrollTarget(event.target);
    const touch = event.touches[0];
    trailingFullViewTouch = scroll && touch ? { scroll, clientY: touch.clientY } : null;
  };
  root.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  /** @param {TouchEvent} event */
  const onTouchMove = (event) => {
    const touch = event.touches[0];
    if (!trailingFullViewTouch || !touch) return;
    const deltaY = trailingFullViewTouch.clientY - touch.clientY;
    trailingFullViewTouch.clientY = touch.clientY;
    if (scrollTrailingFullView(trailingFullViewTouch.scroll, deltaY)) event.preventDefault();
  };
  root.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  const endTrailingFullViewTouch = () => {
    trailingFullViewTouch = null;
  };
  root.addEventListener('touchend', endTrailingFullViewTouch, true);
  root.addEventListener('touchcancel', endTrailingFullViewTouch, true);
  /** @param {Event} event */
  const onScroll = (event) => {
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
  };
  root.addEventListener('scroll', onScroll, true);
  return () => {
    fullViewCompactMedia?.removeEventListener('change', onCompactViewChange);
    root.removeEventListener('wheel', onWheel, true);
    root.removeEventListener('touchstart', onTouchStart, true);
    root.removeEventListener('touchmove', onTouchMove, true);
    root.removeEventListener('touchend', endTrailingFullViewTouch, true);
    root.removeEventListener('touchcancel', endTrailingFullViewTouch, true);
    root.removeEventListener('scroll', onScroll, true);
    if (fullViewScrollFrame && defaultView?.cancelAnimationFrame) {
      defaultView.cancelAnimationFrame(fullViewScrollFrame);
    }
  };
}
