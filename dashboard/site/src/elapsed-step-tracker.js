import { formatClockDuration } from './view-formatters.js';

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

  /** @param {string} nextMessage @param {string} nextPhase */
  const update = (nextMessage, nextPhase) => {
    if (phase !== nextPhase) {
      history = [...history, current()].slice(-historyLimit);
      phase = nextPhase;
      startedAt = now();
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
