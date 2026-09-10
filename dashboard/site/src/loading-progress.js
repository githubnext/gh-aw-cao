import { injectStyleOnce } from './dom.js';

const MAX_PROGRESS = 0.94;
const INITIAL_PROGRESS = 0.08;
const MIN_DELAY = 180;
const DELAY_VARIANCE = 420;
const MIN_BURST = 0.08;
const BURST_VARIANCE = 0.22;
const COMPLETION_DURATION = 240;
const activeProgress = new WeakMap();

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
 * Starts an indeterminate progress bar and returns its completion control.
 *
 * @param {Document} document
 * @returns {{ complete: () => void }}
 */
export function startLoadingProgress(document) {
  installStyles(document);

  let state = activeProgress.get(document);
  if (state && !state.bar.isConnected) {
    window.clearTimeout(state.timer);
    window.clearTimeout(state.completionTimer);
    activeProgress.delete(document);
    state = undefined;
  }

  if (!state) {
    const bar = document.createElement('div');
    bar.className = 'loading-progress';
    bar.setAttribute('aria-hidden', 'true');
    state = {
      bar,
      progress: INITIAL_PROGRESS,
      timer: 0,
      completionTimer: 0,
      tasks: 0,
    };
    activeProgress.set(document, state);
    bar.style.transform = `scaleX(${state.progress})`;
    document.body.prepend(bar);
  } else if (state.tasks === 0) {
    window.clearTimeout(state.completionTimer);
    state.bar.classList.remove('loading-progress-complete');
    state.progress = INITIAL_PROGRESS;
    state.bar.style.transform = `scaleX(${state.progress})`;
  }

  state.tasks += 1;
  let completed = false;

  const advance = () => {
    const burst = MIN_BURST + Math.random() * BURST_VARIANCE;
    state.progress += (MAX_PROGRESS - state.progress) * burst;
    state.bar.style.transform = `scaleX(${state.progress})`;
    state.timer = window.setTimeout(advance, MIN_DELAY + Math.random() * DELAY_VARIANCE);
  };

  if (!state.timer) {
    state.timer = window.setTimeout(advance, MIN_DELAY + Math.random() * DELAY_VARIANCE);
  }

  return {
    complete() {
      if (completed) return;
      completed = true;
      state.tasks -= 1;
      if (state.tasks > 0) return;
      window.clearTimeout(state.timer);
      state.timer = 0;
      state.bar.classList.add('loading-progress-complete');
      state.bar.style.transform = 'scaleX(1)';
      state.completionTimer = window.setTimeout(() => {
        if (state.tasks > 0) return;
        state.bar.remove();
        activeProgress.delete(document);
      }, COMPLETION_DURATION);
    },
  };
}
