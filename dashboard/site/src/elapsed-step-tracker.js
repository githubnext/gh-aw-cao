import { formatClockDuration } from './view-formatters.js';
import { createDebug } from './debug.js';

const debugElapsedStepTracker = createDebug('elapsed-step-tracker');

/**
 * Tracks elapsed time for a current step and a bounded history of completed steps.
 * @param {string} initialMessage
 * @param {{ historyLimit?: number, now?: () => number }} [options]
 */
export function createElapsedStepTracker(initialMessage, options = {}) {
  const historyLimit = options.historyLimit ?? 100;
  const now = options.now ?? Date.now;
  let message = initialMessage;
  let phase = 'initial';
  let startedAt = now();
  /** @type {string[]} */
  let history = [];
  let nextStep = 0;
  const current = () => `${message} +${formatClockDuration(now() - startedAt)}`;
  debugElapsedStepTracker({ event: 'created', phase, historyLimit });

  /** @param {string} nextMessage @param {string} nextPhase */
  const update = (nextMessage, nextPhase) => {
    if (phase !== nextPhase) {
      const previousPhase = phase;
      const grown = history.length + 1 > historyLimit;
      history = [...history, current()].slice(-historyLimit);
      phase = nextPhase;
      startedAt = now();
      debugElapsedStepTracker({ event: 'phase-transition', previousPhase, phase, historyLength: history.length, truncated: grown });
    }
    message = nextMessage;
  };

  return {
    /** @param {string} nextMessage */
    advance(nextMessage) {
      if (message === nextMessage) return;
      update(nextMessage, `step-${++nextStep}`);
    },
    update,
    snapshot() {
      const currentMessage = current();
      return {
        message: currentMessage,
        history: [...history, currentMessage].slice(-historyLimit)
      };
    }
  };
}
