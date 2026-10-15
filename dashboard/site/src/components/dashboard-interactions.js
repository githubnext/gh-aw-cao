/**
 * Dashboard-wide navigation interactions.
 */

import { createDebug } from '../debug.js';
import { trackViewTransition } from './lazy-view.js';

const navigationTransitions = new WeakMap();

const debugInteractions = createDebug('dashboard-interactions');

/**
 * @param {Document} document
 * @param {() => void} update
 * @param {'forward'|'backward'} [direction]
 * @param {'page'|'tab'} [kind]
 */
export function updateWithViewTransition(document, update, direction, kind = 'page') {
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

  const owner = {};
  navigationTransitions.set(document, owner);
  document.documentElement.dataset.navigationTransition = kind;
  if (direction && kind === 'page') {
    document.documentElement.dataset.navigationDirection = direction;
  } else {
    delete document.documentElement.dataset.navigationDirection;
  }
  const cleanup = () => {
    if (navigationTransitions.get(document) !== owner) return;
    navigationTransitions.delete(document);
    delete document.documentElement.dataset.navigationDirection;
    delete document.documentElement.dataset.navigationTransition;
    debugInteractions({ event: 'transition-finished', direction: direction ?? null, kind });
  };
  debugInteractions({ event: 'transition-started', direction: direction ?? null, kind });
  let transition;
  try {
    transition = transitionDocument.startViewTransition(update);
  } catch (error) {
    cleanup();
    throw error;
  }
  trackViewTransition(document, transition);
  if (!transition?.finished) {
    cleanup();
    return;
  }
  void Promise.resolve(transition.finished).catch(() => {}).then(cleanup);
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
