import { injectStyleOnce } from './dom.js';

const MAX_PROGRESS = 0.94;
const INITIAL_PROGRESS = 0.08;
const COMPLETION_DURATION = 240;
const activeProgress = new WeakMap();

/**
 * @typedef {{
 *   id: string,
 *   phase: 'start' | 'update' | 'complete',
 *   completed?: number,
 *   total?: number
 * }} WorkerLoadingProgressState
 */

/**
 * @param {Document} document
 */
function installStyles(document) {
  injectStyleOnce(document, 'loading-progress-styles', `
.loading-progress {
  position: fixed;
  z-index: 1000;
  inset: 0 0 auto;
  height: 2px;
  overflow: hidden;
  background: var(--accent);
  opacity: 1;
  pointer-events: none;
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 180ms ease-out, opacity 120ms ease 80ms;
}
.loading-progress::after {
  position: absolute;
  inset: 0;
  content: "";
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--on-emphasis) 65%, transparent), transparent);
  transform: translateX(-100%);
  animation: loading-progress-shimmer 1.2s ease-in-out infinite;
}
.loading-progress-complete {
  opacity: 0;
}
@keyframes loading-progress-shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loading-progress {
    transition: none;
  }
  .loading-progress::after {
    animation: none;
  }
}`);
}

/** @param {{ bar: HTMLElement, operations: Map<string, WorkerLoadingProgressState> }} target */
function renderActiveProgress(target) {
  const current = [...target.operations.values()].at(-1);
  const total = Number(current?.total);
  const completed = Number(current?.completed);
  const progress = Number.isFinite(total) && total > 0 && Number.isFinite(completed)
    ? INITIAL_PROGRESS + (MAX_PROGRESS - INITIAL_PROGRESS) * Math.min(1, Math.max(0, completed / total))
    : INITIAL_PROGRESS;
  target.bar.style.transform = `scaleX(${progress})`;
}

/**
 * Applies data-worker state to the existing top progress bar. The worker owns
 * every operation's start, determinate updates, and completion.
 *
 * @param {Document} document
 * @param {WorkerLoadingProgressState} state
 */
export function setLoadingProgressState(document, state) {
  if (!state || typeof state.id !== 'string' || !['start', 'update', 'complete'].includes(state.phase)) return;

  let active = activeProgress.get(document);
  if (state.phase === 'complete') {
    if (!active) return;
    active.operations.delete(state.id);
    if (active.operations.size > 0) {
      renderActiveProgress(active);
      return;
    }
    active.bar.classList.add('loading-progress-complete');
    active.bar.style.transform = 'scaleX(1)';
    active.completionTimer = window.setTimeout(() => {
      if (active.operations.size > 0) return;
      active.bar.remove();
      activeProgress.delete(document);
    }, COMPLETION_DURATION);
    return;
  }

  installStyles(document);
  if (!active || !active.bar.isConnected) {
    const bar = document.createElement('div');
    bar.className = 'loading-progress';
    bar.setAttribute('aria-hidden', 'true');
    active = {
      bar,
      operations: new Map(),
      completionTimer: 0,
    };
    activeProgress.set(document, active);
    document.body.prepend(bar);
  }
  window.clearTimeout(active.completionTimer);
  active.bar.classList.remove('loading-progress-complete');
  active.operations.delete(state.id);
  active.operations.set(state.id, state);
  renderActiveProgress(active);
}
