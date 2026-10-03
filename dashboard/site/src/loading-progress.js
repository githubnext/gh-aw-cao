import { injectStyleOnce } from './dom.js';
import { effect, onCleanup, state } from './reactive.js';
import { createDebug } from './debug.js';

const MAX_PROGRESS = 0.94;
const INITIAL_PROGRESS = 0.08;
const COMPLETION_DURATION = 240;
/** @type {WeakMap<Document, { bar: HTMLElement, operations: import('./reactive.js').State<Map<string, WorkerLoadingProgressState>>, stop: () => void }>} */
const activeSessions = new WeakMap();

const debugLoadingProgress = createDebug('loading-progress');

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

/**
 * Derives the transform and `aria-valuenow` the bar should show for the
 * worker operation that started most recently among those still pending.
 * @param {Map<string, WorkerLoadingProgressState>} operations
 * @returns {{ transform: string, valueNow: string | null }}
 */
function progressForOperations(operations) {
  const current = [...operations.values()].at(-1);
  const total = Number(current?.total);
  const completed = Number(current?.completed);
  const determinate = Number.isFinite(total) && total > 0 && Number.isFinite(completed);
  const completion = determinate ? Math.min(1, Math.max(0, completed / total)) : 0;
  const progress = determinate
    ? INITIAL_PROGRESS + (MAX_PROGRESS - INITIAL_PROGRESS) * completion
    : INITIAL_PROGRESS;
  return {
    transform: `scaleX(${progress})`,
    valueNow: determinate ? String(Math.min(99, Math.round(completion * 100))) : null
  };
}

/**
 * Creates the owned progress bar element and the effect that renders it from
 * reactive operation state, so every DOM update the worker drives flows
 * through one place instead of being applied ad hoc at each call site.
 * @param {Document} document
 * @param {Map<string, WorkerLoadingProgressState>} initialOperations
 * @returns {{ bar: HTMLElement, operations: import('./reactive.js').State<Map<string, WorkerLoadingProgressState>>, stop: () => void }}
 */
function createLoadingProgressSession(document, initialOperations) {
  const bar = document.createElement('div');
  bar.className = 'loading-progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Loading dashboard data');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  document.body.prepend(bar);

  const operations = state(initialOperations);
  let completionTimer = 0;

  const handle = effect(() => {
    const active = operations.get();
    onCleanup(() => window.clearTimeout(completionTimer));
    if (active.size === 0) {
      bar.style.transform = 'scaleX(1)';
      bar.setAttribute('aria-valuenow', '100');
      bar.classList.add('loading-progress-complete');
      completionTimer = window.setTimeout(() => {
        if (operations.get().size > 0) return;
        bar.remove();
        activeSessions.delete(document);
        handle.stop();
      }, COMPLETION_DURATION);
      return;
    }
    bar.classList.remove('loading-progress-complete');
    const { transform, valueNow } = progressForOperations(active);
    bar.style.transform = transform;
    if (valueNow !== null) bar.setAttribute('aria-valuenow', valueNow);
    else bar.removeAttribute('aria-valuenow');
  });

  return { bar, operations, stop: () => handle.stop() };
}

/**
 * Applies data-worker state to the existing top progress bar. The worker owns
 * every operation's start, determinate updates, and completion; this module
 * only synchronizes that state onto one owned reactive element.
 *
 * @param {Document} document
 * @param {WorkerLoadingProgressState} workerState
 */
export function setLoadingProgressState(document, workerState) {
  if (!workerState || typeof workerState.id !== 'string' || !['start', 'update', 'complete'].includes(workerState.phase)) return;

  const session = activeSessions.get(document);
  if (workerState.phase === 'complete') {
    if (!session) return;
    const nextOperations = new Map(session.operations.get());
    nextOperations.delete(workerState.id);
    session.operations.set(nextOperations);
    if (nextOperations.size === 0) debugLoadingProgress({ event: 'all-operations-complete', id: workerState.id });
    return;
  }

  installStyles(document);
  const isNewSession = !session || !session.bar.isConnected;
  const previousOperations = isNewSession ? new Map() : session.operations.get();
  const nextOperations = new Map(previousOperations);
  nextOperations.set(workerState.id, workerState);

  if (isNewSession) {
    activeSessions.set(document, createLoadingProgressSession(document, nextOperations));
    debugLoadingProgress({ event: 'bar-created', id: workerState.id });
    return;
  }

  if (workerState.phase === 'start' && previousOperations.size > 0) {
    debugLoadingProgress({ event: 'concurrent-operation-started', id: workerState.id, activeCount: nextOperations.size });
  }
  session.operations.set(nextOperations);
}
