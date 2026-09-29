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
import { requestDashboardRefresh } from '../dashboard-data-updates.js';

const ARM_DISTANCE = 72;
const MOVE_THRESHOLD = 12;
const REFRESHING_RESET_DELAY_MS = 600;

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
  }, 'Pull down to refresh');
  scroller.prepend(indicator);
  /** @type {{ startY: number, armed: boolean } | null} */
  let gesture = null;
  const scrollTop = () => Math.max(
    scroller.scrollTop,
    scroller.ownerDocument.scrollingElement?.scrollTop ?? 0
  );
  const reset = () => {
    gesture = null;
    indicator.hidden = true;
    indicator.classList.remove('overview-pull-refresh-armed');
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
    gesture.armed = distance >= ARM_DISTANCE;
    indicator.hidden = false;
    indicator.classList.toggle('overview-pull-refresh-armed', gesture.armed);
    indicator.textContent = gesture.armed ? 'Release to refresh' : 'Pull down to refresh';
  }, { passive: true, signal });
  scroller.addEventListener('touchend', () => {
    if (!gesture?.armed) return reset();
    indicator.textContent = 'Refreshing dashboard';
    requestDashboardRefresh(view);
    view.setTimeout(reset, REFRESHING_RESET_DELAY_MS);
    gesture = null;
  }, { signal });
  scroller.addEventListener('touchcancel', reset, { signal });
  return indicator;
}
