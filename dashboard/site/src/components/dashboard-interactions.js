/**
 * Dashboard-wide navigation interactions.
 */

import { createDebug } from '../debug.js';
import { trackViewTransition } from './lazy-view.js';

const directionalViewTransitions = new WeakMap();

const debugInteractions = createDebug('dashboard-interactions');

/**
 * @param {Document} document
 * @param {() => void} update
 * @param {'forward'|'backward'} [direction]
 */
export function updateWithViewTransition(document, update, direction) {
  const transitionDocument = /** @type {Document & { startViewTransition?: (update: () => void) => { ready?: Promise<unknown>, finished?: Promise<unknown> } | void }} */ (document);
  const unsupported = typeof transitionDocument.startViewTransition !== 'function';
  const prefersReducedMotion = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  if (unsupported || prefersReducedMotion) {
    debugInteractions({
      event: 'transition-skipped',
      reason: unsupported ? 'unsupported' : 'reduced-motion',
      direction: direction ?? null
    });
    update();
    return;
  }

  if (direction) {
    document.documentElement.dataset.navigationDirection = direction;
  } else {
    directionalViewTransitions.delete(document);
    delete document.documentElement.dataset.navigationDirection;
  }
  debugInteractions({ event: 'transition-started', direction: direction ?? null });
  const transition = transitionDocument.startViewTransition(update);
  trackViewTransition(document, transition);
  if (!direction) return;
  if (!transition?.finished) {
    delete document.documentElement.dataset.navigationDirection;
    return;
  }
  directionalViewTransitions.set(document, transition);
  void Promise.resolve(transition.finished).catch(() => {}).then(() => {
    if (directionalViewTransitions.get(document) !== transition) return;
    directionalViewTransitions.delete(document);
    delete document.documentElement.dataset.navigationDirection;
    debugInteractions({ event: 'transition-finished', direction });
  });
}

/**
 * @param {HTMLElement} root
 */
export function enableDashboardKeyboardNavigation(root) {
  root.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || !(event.target instanceof Element)) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const section = event.target.closest('.dashboard-page .page-section');
    const page = section?.closest('.dashboard-page');
    if (!(section instanceof HTMLElement) || !(page instanceof HTMLElement)) return;
    const sections = [...page.querySelectorAll('.page-section')]
      .filter((candidate) => candidate instanceof HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextSection = sections[sections.indexOf(section) + delta];
    if (!nextSection) return;
    event.preventDefault();
    nextSection.focus();
  });
}
