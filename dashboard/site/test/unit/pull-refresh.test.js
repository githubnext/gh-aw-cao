// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { enablePullRefresh } from '../../src/components/pull-refresh.js';

/** @param {HTMLElement} scroller @param {string} type @param {number} clientY */
function touch(scroller, type, clientY) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientY }]
  });
  scroller.dispatchEvent(event);
}

describe('pull refresh component', () => {
  it('prepends a hidden status indicator to the scroller', () => {
    const scroller = document.createElement('main');
    document.body.appendChild(scroller);
    const controller = new AbortController();

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });

    /** @type {HTMLDivElement | null} */
    const indicator = scroller.querySelector('.overview-pull-refresh');
    expect(indicator?.hidden).toBe(true);
    expect(indicator?.textContent).toBe('Pull down to refresh');
    controller.abort();
    scroller.remove();
  });

  it('requests a dashboard refresh only when the caller reports the page is active', () => {
    const scroller = document.createElement('main');
    document.body.appendChild(scroller);
    const controller = new AbortController();
    const onRefresh = vi.fn();
    window.addEventListener('dashboard-refresh-request', onRefresh);

    enablePullRefresh({ scroller, view: window, isActive: () => false, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);
    expect(/** @type {HTMLDivElement} */ (scroller.querySelector('.overview-pull-refresh'))?.hidden).toBe(true);
    touch(scroller, 'touchend', 180);

    expect(onRefresh).not.toHaveBeenCalled();
    window.removeEventListener('dashboard-refresh-request', onRefresh);
    controller.abort();
    scroller.remove();
  });

  it('arms and requests a refresh once the gesture crosses the arm distance while active', () => {
    const scroller = document.createElement('main');
    document.body.appendChild(scroller);
    const controller = new AbortController();
    const onRefresh = vi.fn();
    window.addEventListener('dashboard-refresh-request', onRefresh);

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);
    expect(scroller.querySelector('.overview-pull-refresh')?.textContent).toBe('Release to refresh');
    touch(scroller, 'touchend', 180);

    expect(onRefresh).toHaveBeenCalledOnce();
    window.removeEventListener('dashboard-refresh-request', onRefresh);
    controller.abort();
    scroller.remove();
  });

  it('resets without refreshing when the gesture is released before the arm distance', () => {
    const scroller = document.createElement('main');
    document.body.appendChild(scroller);
    const controller = new AbortController();
    const onRefresh = vi.fn();
    window.addEventListener('dashboard-refresh-request', onRefresh);

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 120);
    expect(scroller.querySelector('.overview-pull-refresh')?.textContent).toBe('Pull down to refresh');
    touch(scroller, 'touchend', 120);

    expect(onRefresh).not.toHaveBeenCalled();
    window.removeEventListener('dashboard-refresh-request', onRefresh);
    controller.abort();
    scroller.remove();
  });
});
