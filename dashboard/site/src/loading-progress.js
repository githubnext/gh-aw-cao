const MAX_PROGRESS = 0.94
const INITIAL_PROGRESS = 0.08
const MIN_DELAY = 180
const DELAY_VARIANCE = 420
const MIN_BURST = 0.08
const BURST_VARIANCE = 0.22
const COMPLETION_DURATION = 240

/**
 * @param {Document} document
 */
function installStyles(document) {
  if (document.querySelector('style[data-loading-progress-styles]')) return

  const style = document.createElement('style')
  style.dataset.loadingProgressStyles = ''
  style.textContent = `
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
}`
  document.head.append(style)
}

/**
 * Starts an indeterminate progress bar and returns its completion control.
 *
 * @param {Document} document
 * @returns {{ complete: () => void }}
 */
export function startLoadingProgress(document) {
  installStyles(document)

  const bar = document.createElement('div')
  bar.className = 'loading-progress'
  bar.setAttribute('aria-hidden', 'true')

  let progress = INITIAL_PROGRESS
  let timer = 0
  let completed = false

  const advance = () => {
    const burst = MIN_BURST + Math.random() * BURST_VARIANCE
    progress += (MAX_PROGRESS - progress) * burst
    bar.style.transform = `scaleX(${progress})`
    timer = window.setTimeout(
      advance,
      MIN_DELAY + Math.random() * DELAY_VARIANCE,
    )
  }

  bar.style.transform = `scaleX(${progress})`
  document.body.prepend(bar)
  timer = window.setTimeout(advance, MIN_DELAY + Math.random() * DELAY_VARIANCE)

  return {
    complete() {
      if (completed) return
      completed = true
      window.clearTimeout(timer)
      bar.classList.add('loading-progress-complete')
      bar.style.transform = 'scaleX(1)'
      window.setTimeout(() => bar.remove(), COMPLETION_DURATION)
    },
  }
}
