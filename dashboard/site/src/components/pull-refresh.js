/**
 * Reusable mobile pull-down-to-refresh gesture for a dashboard page.
 *
 * Binds a touch gesture to a scroller and requests a dashboard refresh once
 * the gesture is armed and released, but only while the caller-identified
 * page is active and the scroller is already at its top. This primitive
 * takes no page identity of its own; callers supply the active-page check
 * so the same gesture wiring composes with any declared `pull-refresh: true`
 * page rather than being wired to one built-in page.
 */

import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { requestDashboardRefresh } from '../dashboard-data-updates.js';
import { createDebug } from '../debug.js';

const ARM_DISTANCE = 72;
const MOVE_THRESHOLD = 12;
const REFRESHING_RESET_DELAY_MS = 600;

const debugPullRefresh = createDebug('pull-refresh');

/** @typedef {{ visible: boolean, armed: boolean, label: string }} PullRefreshViewModel */
/** @type {PullRefreshViewModel} */
const RESET_VIEW = { visible: false, armed: false, label: 'Pull down to refresh' };

/**
 * @param {{
 *   scroller: HTMLElement,
 *   view: Window & typeof globalThis,
 *   isActive: () => boolean,
 *   signal: AbortSignal
 * }} options
 * @returns {HTMLElement} the pull-refresh status indicator, already prepended to the scroller
 */
export function enablePullRefresh({ scroller, view, isActive, signal }) {
  const indicator = h('div', {
    className: 'overview-pull-refresh',
    role: 'status',
    'aria-live': 'polite',
    hidden: true
  });
  scroller.prepend(indicator);
  const viewModel = state(RESET_VIEW);
  // Owns the indicator's visibility, armed styling, and label as one reactive
  // sink so the gesture handlers below only ever call `viewModel.set(...)`
  // instead of writing `hidden`/`classList`/`textContent` at each call site.
  effect(() => {
    const current = viewModel.get();
    indicator.hidden = !current.visible;
    indicator.classList.toggle('overview-pull-refresh-armed', current.armed);
    indicator.textContent = current.label;
  }, { signal });
  /** @type {{ startY: number, armed: boolean } | null} */
  let gesture = null;
  const scrollTop = () => Math.max(
    scroller.scrollTop,
    scroller.ownerDocument.scrollingElement?.scrollTop ?? 0
  );
  const reset = () => {
    gesture = null;
    viewModel.set(RESET_VIEW);
  };
  scroller.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    gesture = touch && event.touches.length === 1 && isActive() && scrollTop() <= 0
      ? { startY: touch.clientY, armed: false }
      : null;
  }, { passive: true, signal });
  scroller.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (!gesture || !touch || scrollTop() > 0) return reset();
    const distance = Math.max(0, touch.clientY - gesture.startY);
    if (distance < MOVE_THRESHOLD) return;
    const wasArmed = gesture.armed;
    gesture.armed = distance >= ARM_DISTANCE;
    if (gesture.armed && !wasArmed) debugPullRefresh({ event: 'armed' });
    viewModel.set({
      visible: true,
      armed: gesture.armed,
      label: gesture.armed ? 'Release to refresh' : 'Pull down to refresh'
    });
  }, { passive: true, signal });
  scroller.addEventListener('touchend', () => {
    if (!gesture?.armed) return reset();
    viewModel.set((current) => ({ ...current, label: 'Refreshing dashboard' }));
    debugPullRefresh({ event: 'refresh-requested' });
    requestDashboardRefresh(view);
    view.setTimeout(() => {
      reset();
      debugPullRefresh({ event: 'cycle-complete' });
    }, REFRESHING_RESET_DELAY_MS);
    gesture = null;
  }, { signal });
  scroller.addEventListener('touchcancel', reset, { signal });
  return indicator;
}
